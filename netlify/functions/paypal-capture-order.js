import { getStore } from "@netlify/blobs";

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const env = process.env.PAYPAL_ENV || "sandbox";

  if (!clientId || !clientSecret) {
    throw new Error("Missing PayPal credentials");
  }

  const baseUrl =
    env === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";

  const auth = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    throw new Error(`PayPal OAuth failed: ${response.status}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    baseUrl
  };
}

function jsonResponse(body, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
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

    const store = getStore({
      name: "stemplayer-commerce",
      consistency: "strong"
    });

    /*
     * STEP 1
     * Check our ledger BEFORE doing anything with PayPal.
     *
     * If this order has already been processed, return the
     * recorded result. Do not capture again and do not change sold.
     */
    const initialState = await store.get("state.json", {
      type: "json",
      consistency: "strong"
    });

    if (!initialState) {
      throw new Error("Commerce state not initialized");
    }

    const alreadyProcessed =
      initialState.processed_orders?.[orderId];

    if (alreadyProcessed?.sold_counted) {
      return jsonResponse({
        ok: true,
        order_id: orderId,
        status: "COMPLETED",
        capture_id: alreadyProcessed.capture_id || null,
        amount: {
          currency_code: alreadyProcessed.currency || "USD",
          value: alreadyProcessed.amount || null
        },
        early_bird: Boolean(alreadyProcessed.early_bird),
        idempotent: true
      });
    }

    const { accessToken, baseUrl } = await getAccessToken();

    /*
     * STEP 2
     * Read the PayPal order BEFORE capture.
     * Never trust price/product/reservation data from the browser.
     */
    const orderResponse = await fetch(
      `${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const orderData = await orderResponse.json();

    if (!orderResponse.ok) {
      return jsonResponse(
        {
          ok: false,
          paypal_status: orderResponse.status,
          error: "Unable to read PayPal order",
          details: orderData
        },
        502
      );
    }

    const purchaseUnit = orderData.purchase_units?.[0];

    const amount =
      purchaseUnit?.amount?.value ?? null;

    const currency =
      purchaseUnit?.amount?.currency_code ?? null;

    const referenceId =
      purchaseUnit?.reference_id ?? null;

    const reservationId =
      purchaseUnit?.custom_id ?? null;

    const isEarlyBird =
      referenceId === "STEMPLAYER_V2_EARLY_BIRD";

    const isStandard =
      referenceId === "STEMPLAYER_V2_STANDARD";

    if (!isEarlyBird && !isStandard) {
      return jsonResponse(
        {
          ok: false,
          error: "Unknown StemPlayer product"
        },
        400
      );
    }

    /*
     * STEP 3
     * Verify authoritative price.
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
          error: "PayPal order amount does not match current product price"
        },
        400
      );
    }

    /*
     * STEP 4
     * Early Bird requires a live reservation.
     */
    if (isEarlyBird) {
      if (!reservationId) {
        return jsonResponse(
          {
            ok: false,
            error: "Missing Early Bird reservation"
          },
          409
        );
      }

      const reservation =
        initialState.early_bird_reservations?.[reservationId];

      if (!reservation) {
        return jsonResponse(
          {
            ok: false,
            error: "Early Bird reservation not found or already used"
          },
          409
        );
      }

      const expiresAt =
        Date.parse(reservation.expires_at);

      if (
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      ) {
        return jsonResponse(
          {
            ok: false,
            error: "Early Bird reservation expired"
          },
          409
        );
      }
    }

    /*
     * STEP 5
     * Capture PayPal.
     */
    const captureResponse = await fetch(
      `${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: "{}"
      }
    );

    const captureData = await captureResponse.json();

    if (!captureResponse.ok) {
      return jsonResponse(
        {
          ok: false,
          paypal_status: captureResponse.status,
          error: "PayPal capture failed",
          details: captureData
        },
        502
      );
    }

    if (captureData.status !== "COMPLETED") {
      return jsonResponse(
        {
          ok: false,
          error: "PayPal capture did not complete",
          status: captureData.status
        },
        502
      );
    }

    const capture =
      captureData.purchase_units?.[0]
        ?.payments?.captures?.[0];

    if (!capture || capture.status !== "COMPLETED") {
      throw new Error("Completed capture missing from PayPal response");
    }

    const captureId = capture.id;
    const capturedAmount = capture.amount?.value;
    const capturedCurrency = capture.amount?.currency_code;

    if (
      capturedCurrency !== currency ||
      capturedAmount !== amount
    ) {
      throw new Error("Captured amount does not match verified order");
    }

    /*
     * STEP 6
     * Atomically record the order in our ledger.
     *
     * For Early Bird, the SAME atomic write also:
     *   - removes the reservation
     *   - increments sold exactly once
     *
     * For Standard, sold is not changed.
     */
    let recorded = false;

    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await store.getWithMetadata(
        "state.json",
        {
          type: "json",
          consistency: "strong"
        }
      );

      if (!result?.data) {
        throw new Error("Commerce state not initialized");
      }

      const currentState = result.data;

      const processedOrders = {
        ...(currentState.processed_orders ?? {})
      };

      /*
       * Another invocation may have completed the ledger write
       * while this invocation was waiting.
       */
      if (processedOrders[orderId]?.sold_counted) {
        const existing = processedOrders[orderId];

        return jsonResponse({
          ok: true,
          order_id: orderId,
          status: "COMPLETED",
          capture_id: existing.capture_id || captureId,
          amount: {
            currency_code: existing.currency || capturedCurrency,
            value: existing.amount || capturedAmount
          },
          early_bird: Boolean(existing.early_bird),
          idempotent: true
        });
      }

      const reservations = {
        ...(currentState.early_bird_reservations ?? {})
      };

      if (isEarlyBird && !reservations[reservationId]) {
        throw new Error(
          "Captured Early Bird reservation disappeared before ledger write"
        );
      }

      if (isEarlyBird) {
        delete reservations[reservationId];
      }

      const sold =
        currentState.early_bird_sold ??
        currentState.early_bird_used ??
        0;

      const now = Date.now();

      const activeReservations =
        Object.fromEntries(
          Object.entries(reservations).filter(
            ([, item]) => {
              const expiresAt =
                Date.parse(item.expires_at);

              return (
                Number.isFinite(expiresAt) &&
                expiresAt > now
              );
            }
          )
        );

      processedOrders[orderId] = {
        capture_id: captureId,
        amount: capturedAmount,
        currency: capturedCurrency,
        early_bird: isEarlyBird,
        sold_counted: true,
        license: null
      };

      const nextState = {
        ...currentState,
        early_bird_sold:
          isEarlyBird ? sold + 1 : sold,
        early_bird_reserved:
          Object.keys(activeReservations).length,
        early_bird_reservations:
          activeReservations,
        processed_orders: processedOrders
      };

      delete nextState.early_bird_used;

      const writeResult = await store.setJSON(
        "state.json",
        nextState,
        {
          onlyIfMatch: result.etag
        }
      );

      if (writeResult.modified) {
        recorded = true;
        break;
      }
    }

    if (!recorded) {
      throw new Error(
        "Unable to record completed PayPal order"
      );
    }

    return jsonResponse({
      ok: true,
      order_id: captureData.id,
      status: captureData.status,
      capture_id: captureId,
      amount: {
        currency_code: capturedCurrency,
        value: capturedAmount
      },
      early_bird: isEarlyBird,
      idempotent: false
    });
  } catch (error) {
    console.error("paypal-capture-order failed:", error);

    return jsonResponse(
      {
        ok: false,
        error: "Unexpected server error"
      },
      500
    );
  }
};