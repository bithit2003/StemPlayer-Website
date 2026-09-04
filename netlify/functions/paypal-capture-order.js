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

    const { accessToken, baseUrl } = await getAccessToken();

    /*
     * STEP 1
     * Read the PayPal order BEFORE capture.
     * Never trust amount/reservation information from the browser.
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

    /*
     * STEP 2
     * Determine which StemPlayer product PayPal says this is.
     */
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
     * Load authoritative commerce pricing/state.
     */
    const state = await store.get("state.json", {
      type: "json",
      consistency: "strong"
    });

    if (!state) {
      throw new Error("Commerce state not initialized");
    }

    const expectedAmount = isEarlyBird
      ? state.early_bird_price_usd
      : state.regular_price_usd;

    /*
     * STEP 4
     * Verify PayPal amount and currency BEFORE taking money.
     */
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
     * STEP 5
     * Early Bird orders MUST have a live reservation.
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
        state.early_bird_reservations?.[reservationId];

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
     * STEP 6
     * The order has passed our checks.
     * Capture the PayPal payment.
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

    /*
     * STEP 7
     * Convert Early Bird reservation -> sold.
     *
     * Use CAS so concurrent customers cannot overwrite
     * each other's commerce state.
     */
    if (isEarlyBird) {
      let converted = false;

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

        const reservations = {
          ...(currentState.early_bird_reservations ?? {})
        };

        const reservation =
          reservations[reservationId];

        if (!reservation) {
          throw new Error(
            "Captured payment reservation disappeared before conversion"
          );
        }

        delete reservations[reservationId];

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

        const nextState = {
          ...currentState,
          early_bird_sold: sold + 1,
          early_bird_reserved:
            Object.keys(activeReservations).length,
          early_bird_reservations:
            activeReservations
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
          converted = true;
          break;
        }
      }

      if (!converted) {
        throw new Error(
          "Unable to convert Early Bird reservation to sold"
        );
      }
    }

    const capture =
      captureData.purchase_units?.[0]
        ?.payments?.captures?.[0];

    return jsonResponse({
      ok: true,
      order_id: captureData.id,
      status: captureData.status,
      capture_id: capture?.id || null,
      amount: capture?.amount || null,
      early_bird: isEarlyBird
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