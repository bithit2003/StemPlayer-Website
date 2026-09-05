import { getStore } from "@netlify/blobs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const env = process.env.PAYPAL_ENV ?? "sandbox";

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

  const response = await fetch(
    `${baseUrl}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    }
  );

  if (!response.ok) {
    throw new Error(
      `PayPal OAuth failed: ${response.status}`
    );
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    baseUrl
  };
}

async function fetchPayPalOrder(
  baseUrl,
  accessToken,
  orderId
) {
  const response = await fetch(
    `${baseUrl}/v2/checkout/orders/${orderId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `PayPal order lookup failed: ${response.status}`
    );
  }

  return response.json();
}

export default async (request) => {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("order_id");

    if (!orderId) {
      return jsonResponse(
        { ok: false, error: "Missing order_id" },
        400
      );
    }

    /*
     * SAFETY:
     * Dedicated TEST store only.
     * Production stemplayer-commerce is never opened here.
     */
    const store = getStore({
      name: "stemplayer-commerce-recovery-test",
      consistency: "strong"
    });

    const {
      accessToken,
      baseUrl
    } = await getPayPalAccessToken();

    const orderData = await fetchPayPalOrder(
      baseUrl,
      accessToken,
      orderId
    );

    if (orderData.status !== "COMPLETED") {
      return jsonResponse(
        {
          ok: false,
          error: "Test requires an already COMPLETED PayPal order",
          paypal_status: orderData.status
        },
        409
      );
    }

    const purchaseUnit =
      orderData.purchase_units?.[0];

    const capture =
      purchaseUnit?.payments?.captures?.find(
        (item) => item.status === "COMPLETED"
      );

    if (!capture) {
      throw new Error(
        "No COMPLETED PayPal capture found"
      );
    }

    const referenceId =
      purchaseUnit.reference_id;

    let isEarlyBird;

    if (
      referenceId === "STEMPLAYER_V2_EARLY_BIRD"
    ) {
      isEarlyBird = true;
    } else if (
      referenceId === "STEMPLAYER_V2_STANDARD"
    ) {
      isEarlyBird = false;
    } else {
      throw new Error(
        "Unexpected StemPlayer product reference"
      );
    }

    const amount = capture.amount?.value;
    const currency =
      capture.amount?.currency_code;

    const expectedAmount =
      isEarlyBird ? "5.00" : "9.99";

    if (
      currency !== "USD" ||
      amount !== expectedAmount
    ) {
      throw new Error(
        "Unexpected completed capture amount"
      );
    }

    /*
     * Simulated isolated ledger.
     * If missing, initialize with zero sold.
     */
    for (let attempt = 0; attempt < 5; attempt++) {
      let result = await store.getWithMetadata(
        "state.json",
        {
          type: "json",
          consistency: "strong"
        }
      );

      if (!result?.data) {
        await store.setJSON("state.json", {
          early_bird_sold: 0,
          processed_orders: {}
        });

        result = await store.getWithMetadata(
          "state.json",
          {
            type: "json",
            consistency: "strong"
          }
        );
      }

      const state = result.data;

      const processedOrders = {
        ...(state.processed_orders ?? {})
      };

      const existing =
        processedOrders[orderId];

      /*
       * Second/subsequent call:
       * prove idempotency in the isolated ledger.
       */
      if (existing?.sold_counted) {
        return jsonResponse({
          ok: true,
          test_store:
            "stemplayer-commerce-recovery-test",
          paypal_status: "COMPLETED",
          order_id: orderId,
          capture_id: existing.capture_id,
          amount: {
            currency_code: existing.currency,
            value: existing.amount
          },
          early_bird: Boolean(
            existing.early_bird
          ),
          recovery_written: false,
          idempotent: true,
          test_early_bird_sold:
            state.early_bird_sold ?? 0
        });
      }

      let sold =
        Number(state.early_bird_sold ?? 0);

      if (isEarlyBird) {
        sold += 1;
      }

      processedOrders[orderId] = {
        capture_id: capture.id,
        amount,
        currency,
        early_bird: isEarlyBird,
        sold_counted: true
      };

      const nextState = {
        ...state,
        early_bird_sold: sold,
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
        return jsonResponse({
          ok: true,
          test_store:
            "stemplayer-commerce-recovery-test",
          paypal_status: "COMPLETED",
          order_id: orderId,
          capture_id: capture.id,
          amount: {
            currency_code: currency,
            value: amount
          },
          early_bird: isEarlyBird,
          recovery_written: true,
          idempotent: false,
          test_early_bird_sold: sold
        });
      }
    }

    throw new Error(
      "Unable to write isolated recovery ledger"
    );
  } catch (error) {
    console.error(
      "Recovery harness failed:",
      error
    );

    return jsonResponse(
      {
        ok: false,
        error: "Recovery harness failed"
      },
      500
    );
  }
};