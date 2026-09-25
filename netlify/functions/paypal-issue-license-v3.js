import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const V3_STANDARD_PRICE_USD = "29.99";
const V3_UPGRADE_PRICE_USD = "20.00";

function canonicalLicensePayload(payload) {
  // Must match Python:
  // json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False)
  //
  // Alphabetical order:
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
          'attachment; filename="StemPlayer_V3.license"',
        "Cache-Control": "no-store"
      }
    }
  );
}

function createSignedLicense(captureId, privateKeyB64) {
  const licensePayload = {
    schema: 1,
    product: "StemPlayer",
    edition: "V3",
    license_id:
      "SPV3-" +
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
    const orderId =
      url.searchParams.get("order_id");

    if (!orderId) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing order_id"
        },
        400
      );
    }

    /*
     * V3 uses the same Ed25519 key material as V2.
     *
     * Prefer the V3 alias if configured, but retain
     * the V2 variable as the compatibility fallback.
     */

    const privateKeyB64 =
      process.env.STEMPLAYER_V3_PRIVATE_KEY_B64 ||
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
     * Read authoritative shared commerce ledger.
     */
    const initialState =
      await store.get(
        "state.json",
        {
          type: "json",
          consistency: "strong"
        }
      );

    if (!initialState) {
      throw new Error(
        "Commerce state not initialized"
      );
    }

    const processedOrder =
      initialState.processed_orders?.[orderId];

    /*
     * V3 authorization gate.
     *
     * Never accept a legacy V2 record merely because
     * it exists in the shared processed_orders ledger.
     */
    if (
      !processedOrder?.payment_processed ||
      processedOrder.edition !== "V3"
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Order has not completed StemPlayer V3 payment processing"
        },
        409
      );
    }

    /*
     * STEP 2
     * Idempotency fast path.
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

    const offer =
      processedOrder.offer;

    const upgradeFrom =
      processedOrder.upgrade_from ?? null;

    if (!captureId) {
      throw new Error(
        "Processed V3 order is missing capture_id"
      );
    }

    /*
     * STEP 3
     * Validate V3 commercial contract.
     *
     * standard = USD 29.99
     * upgrade  = USD 20.00
     */
    let expectedAmount;

    if (offer === "standard") {
      expectedAmount =
        V3_STANDARD_PRICE_USD;

      if (upgradeFrom !== null) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Standard V3 order contains invalid upgrade metadata"
          },
          409
        );
      }
    } else if (offer === "upgrade") {
      expectedAmount =
        V3_UPGRADE_PRICE_USD;

      if (
        !upgradeFrom ||
        upgradeFrom.edition !== "V2" ||
        !upgradeFrom.license_id
      ) {
        return jsonResponse(
          {
            ok: false,
            error:
              "V3 upgrade order is missing valid V2 upgrade metadata"
          },
          409
        );
      }
    } else {
      return jsonResponse(
        {
          ok: false,
          error: "Unknown StemPlayer V3 offer"
        },
        409
      );
    }

    if (
      currency !== "USD" ||
      amount !== expectedAmount
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Processed payment amount does not match StemPlayer V3 offer"
        },
        409
      );
    }

    /*
     * STEP 4
     * Generate one candidate V3 license.
     */
    const candidateLicense =
      createSignedLicense(
        captureId,
        privateKeyB64
      );

    /*
     * STEP 5
     * Atomically attach the V3 license to the
     * existing PayPal order.
     */
    for (
      let attempt = 0;
      attempt < 5;
      attempt++
    ) {
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

      const currentState =
        result.data;

      const processedOrders = {
        ...(currentState.processed_orders ?? {})
      };

      const currentOrder =
        processedOrders[orderId];

      if (
        !currentOrder?.payment_processed ||
        currentOrder.edition !== "V3"
      ) {
        throw new Error(
          "Processed V3 order disappeared before license issuance"
        );
      }

      /*
       * Another invocation may already have won.
       */
      if (currentOrder.license) {
        return licenseResponse(
          currentOrder.license
        );
      }

      /*
       * Protect against ledger mutation between reads.
       */
      if (
        currentOrder.capture_id !== captureId ||
        currentOrder.amount !== amount ||
        currentOrder.currency !== currency ||
        currentOrder.offer !== offer ||
        JSON.stringify(
          currentOrder.upgrade_from ?? null
        ) !==
          JSON.stringify(
            upgradeFrom
          )
      ) {
        throw new Error(
          "Processed V3 order changed during license issuance"
        );
      }

      processedOrders[orderId] = {
        ...currentOrder,
        license: candidateLicense
      };

      const nextState = {
        ...currentState,
        processed_orders:
          processedOrders
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
     * Final recovery read after CAS conflicts.
     */
    const finalState =
      await store.get(
        "state.json",
        {
          type: "json",
          consistency: "strong"
        }
      );

    const finalLicense =
      finalState
        ?.processed_orders?.[orderId]
        ?.license;

    if (finalLicense) {
      return licenseResponse(
        finalLicense
      );
    }

    throw new Error(
      "Unable to persist StemPlayer V3 license"
    );
  } catch (error) {
    console.error(
      "V3 license issuance failed:",
      error
    );

    return jsonResponse(
      {
        ok: false,
        error:
          "StemPlayer V3 license issuance failed"
      },
      500
    );
  }
};