import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

function canonicalLicensePayload(payload) {
  // Phải khớp Python:
  // json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False)
  //
  // Thứ tự alphabet:
  // edition, issued_at, license_id, product, purchase_ref, schema
  const sortedPayload = {
    edition: payload.edition,
    issued_at: payload.issued_at,
    license_id: payload.license_id,
    product: payload.product,
    purchase_ref: payload.purchase_ref,
    schema: payload.schema
  };

  return JSON.stringify(sortedPayload);
}

function jsonResponse(body, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}

function licenseResponse(license) {
  return new Response(
    JSON.stringify(license, null, 2),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition":
          'attachment; filename="StemPlayer_V2.license"',
        "Cache-Control": "no-store"
      }
    }
  );
}

function createSignedLicense(captureId, privateKeyB64) {
  const licensePayload = {
    schema: 1,
    product: "StemPlayer",
    edition: "V2",
    license_id:
      "SPV2-" +
      crypto.randomBytes(6)
        .toString("hex")
        .toUpperCase(),
    purchase_ref: captureId,
    issued_at: new Date().toISOString()
  };

  const canonical =
    canonicalLicensePayload(licensePayload);

  const privateKeyPemBytes =
    Buffer.from(privateKeyB64, "base64");

  const privateKey = crypto.createPrivateKey({
    key: privateKeyPemBytes,
    format: "pem"
  });

  const signature = crypto.sign(
    null,
    Buffer.from(canonical, "utf8"),
    privateKey
  );

  return {
    ...licensePayload,
    signature: signature.toString("base64")
  };
}

export default async (request) => {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("order_id");

    if (!orderId) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing order_id"
        },
        400
      );
    }

    const privateKeyB64 =
      process.env.STEMPLAYER_V2_PRIVATE_KEY_B64;

    if (!privateKeyB64) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing StemPlayer signing key"
        },
        500
      );
    }

    const store = getStore({
      name: "stemplayer-commerce",
      consistency: "strong"
    });

    /*
     * STEP 1
     * Read our authoritative commerce ledger.
     *
     * A license may only be issued for an order that has already
     * completed the capture/accounting flow.
     */
    const initialState = await store.get(
      "state.json",
      {
        type: "json",
        consistency: "strong"
      }
    );

    if (!initialState) {
      throw new Error("Commerce state not initialized");
    }

    const processedOrder =
      initialState.processed_orders?.[orderId];

    if (!processedOrder?.sold_counted) {
      return jsonResponse(
        {
          ok: false,
          error: "Order has not completed StemPlayer payment processing"
        },
        409
      );
    }

    /*
     * STEP 2
     * Idempotency fast path.
     *
     * If this order already owns a license, return exactly that
     * license. Never generate another license ID/signature.
     */
    if (processedOrder.license) {
      return licenseResponse(
        processedOrder.license
      );
    }

    const captureId =
      processedOrder.capture_id;

    const amount =
      processedOrder.amount;

    const currency =
      processedOrder.currency;

    const isEarlyBird =
      Boolean(processedOrder.early_bird);

    if (!captureId) {
      throw new Error(
        "Processed order is missing capture_id"
      );
    }

    /*
     * STEP 3
     * Validate the recorded product/payment against commerce state.
     *
     * This supports BOTH:
     *   Early Bird = $5.00
     *   Standard   = $9.99
     *
     * No more hard-coded $5-only license issuance.
     */
    const expectedAmount = isEarlyBird
      ? initialState.early_bird_price_usd
      : initialState.regular_price_usd;

    if (
      currency !== "USD" ||
      amount !== expectedAmount
    ) {
      return jsonResponse(
        {
          ok: false,
          error: "Processed payment amount does not match product price"
        },
        409
      );
    }

    /*
     * STEP 4
     * Generate one candidate license.
     *
     * Under concurrency, more than one invocation might temporarily
     * generate a candidate, but only ONE can win the CAS write.
     * Losing invocations will read and return the winner's license.
     */
    const candidateLicense =
      createSignedLicense(
        captureId,
        privateKeyB64
      );

    /*
     * STEP 5
     * Atomically attach the license to this PayPal order.
     */
    for (let attempt = 0; attempt < 5; attempt++) {
      const result =
        await store.getWithMetadata(
          "state.json",
          {
            type: "json",
            consistency: "strong"
          }
        );

      if (!result?.data) {
        throw new Error(
          "Commerce state not initialized"
        );
      }

      const currentState = result.data;

      const processedOrders = {
        ...(currentState.processed_orders ?? {})
      };

      const currentOrder =
        processedOrders[orderId];

      if (!currentOrder?.sold_counted) {
        throw new Error(
          "Processed order disappeared before license issuance"
        );
      }

      /*
       * Another invocation may already have won the race.
       * Return its license, not our candidate.
       */
      if (currentOrder.license) {
        return licenseResponse(
          currentOrder.license
        );
      }

      /*
       * Protect against ledger mutation/corruption between reads.
       */
      if (
        currentOrder.capture_id !== captureId ||
        currentOrder.amount !== amount ||
        currentOrder.currency !== currency ||
        Boolean(currentOrder.early_bird) !== isEarlyBird
      ) {
        throw new Error(
          "Processed order changed during license issuance"
        );
      }

      processedOrders[orderId] = {
        ...currentOrder,
        license: candidateLicense
      };

      const nextState = {
        ...currentState,
        processed_orders: processedOrders
      };

      const writeResult =
        await store.setJSON(
          "state.json",
          nextState,
          {
            onlyIfMatch: result.etag
          }
        );

      if (writeResult.modified) {
        return licenseResponse(
          candidateLicense
        );
      }
    }

    /*
     * Rare final recovery read:
     * another concurrent invocation may have written the license
     * after our last CAS conflict.
     */
    const finalState = await store.get(
      "state.json",
      {
        type: "json",
        consistency: "strong"
      }
    );

    const finalLicense =
      finalState?.processed_orders?.[orderId]
        ?.license;

    if (finalLicense) {
      return licenseResponse(finalLicense);
    }

    throw new Error(
      "Unable to persist StemPlayer license"
    );
  } catch (error) {
    console.error(
      "License issuance failed:",
      error
    );

    return jsonResponse(
      {
        ok: false,
        error: "License issuance failed"
      },
      500
    );
  }
};