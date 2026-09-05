import { getStore } from "@netlify/blobs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
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
    const text = await response.text();

    throw new Error(
      `PayPal order lookup failed: ${response.status} ${text}`
    );
  }

  return response.json();
}

function inspectOrder(orderData, state) {
  const purchaseUnit =
    orderData.purchase_units?.[0];

  if (!purchaseUnit) {
    throw new Error(
      "PayPal order has no purchase unit"
    );
  }

  const referenceId =
    purchaseUnit.reference_id;

  const orderAmount =
    purchaseUnit.amount?.value;

  const currency =
    purchaseUnit.amount?.currency_code;

  const reservationId =
    purchaseUnit.custom_id ?? null;

  const earlyBirdPrice =
    state.early_bird_price_usd ?? "5.00";

  const regularPrice =
    state.regular_price_usd ?? "9.99";

  let isEarlyBird;

  if (
    referenceId ===
    "STEMPLAYER_V2_EARLY_BIRD"
  ) {
    isEarlyBird = true;
  } else if (
    referenceId ===
    "STEMPLAYER_V2_STANDARD"
  ) {
    isEarlyBird = false;
  } else {
    throw new Error(
      "Unexpected StemPlayer product reference"
    );
  }

  const expectedAmount = isEarlyBird
    ? earlyBirdPrice
    : regularPrice;

  if (
    currency !== "USD" ||
    orderAmount !== expectedAmount
  ) {
    throw new Error(
      "Unexpected PayPal order amount"
    );
  }

  return {
    isEarlyBird,
    reservationId,
    amount: orderAmount,
    currency
  };
}

function extractCompletedCapture(orderData) {
  const captures =
    orderData.purchase_units?.[0]
      ?.payments?.captures ?? [];

  const capture = captures.find(
    (item) => item.status === "COMPLETED"
  );

  if (!capture) {
    return null;
  }

  return {
    captureId: capture.id,
    amount: capture.amount?.value,
    currency: capture.amount?.currency_code
  };
}

async function persistCompletedOrder({
  store,
  orderId,
  captureId,
  amount,
  currency,
  isEarlyBird,
  reservationId
}) {
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

    const state = result.data;

    const processedOrders = {
      ...(state.processed_orders ?? {})
    };

    const existing =
      processedOrders[orderId];

    /*
     * Another invocation already completed
     * accounting for this exact order.
     */
    if (existing?.sold_counted) {
      if (
        existing.capture_id !== captureId
      ) {
        throw new Error(
          "Order ledger capture mismatch"
        );
      }

      return {
        alreadyProcessed: true,
        record: existing
      };
    }

    const reservations = {
      ...(state.early_bird_reservations ?? {})
    };

    /*
     * On reconciliation, reservation may already
     * have expired or disappeared. Payment truth
     * comes from PayPal COMPLETED status.
     */
    if (
      isEarlyBird &&
      reservationId &&
      reservations[reservationId]
    ) {
      delete reservations[reservationId];
    }

    let sold =
      Number(
        state.early_bird_sold ??
        state.early_bird_used ??
        0
      );

    if (isEarlyBird) {
      sold += 1;
    }

    const now = Date.now();

    const activeReservations =
      Object.fromEntries(
        Object.entries(reservations).filter(
          ([, reservation]) =>
            Date.parse(
              reservation.expires_at
            ) > now
        )
      );

    processedOrders[orderId] = {
      capture_id: captureId,
      amount,
      currency,
      early_bird: isEarlyBird,
      sold_counted: true,
      license:
        existing?.license ?? null
    };

    const nextState = {
      ...state,
      early_bird_sold: sold,
      early_bird_reserved:
        Object.keys(
          activeReservations
        ).length,
      early_bird_reservations:
        activeReservations,
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
      return {
        alreadyProcessed: false,
        record:
          processedOrders[orderId]
      };
    }
  }

  /*
   * Final recovery read in case another
   * invocation won the last CAS race.
   */
  const finalState =
    await store.get(
      "state.json",
      {
        type: "json",
        consistency: "strong"
      }
    );

  const finalRecord =
    finalState?.processed_orders?.[
      orderId
    ];

  if (finalRecord?.sold_counted) {
    return {
      alreadyProcessed: true,
      record: finalRecord
    };
  }

  throw new Error(
    "Unable to persist completed PayPal order"
  );
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

    const store = getStore({
      name: "stemplayer-commerce",
      consistency: "strong"
    });

    /*
     * FAST IDEMPOTENCY PATH
     *
     * If our ledger already processed the order,
     * do not even ask PayPal to capture again.
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

    const alreadyProcessed =
      initialState.processed_orders?.[
        orderId
      ];

    if (alreadyProcessed?.sold_counted) {
      return jsonResponse({
        ok: true,
        order_id: orderId,
        status: "COMPLETED",
        capture_id:
          alreadyProcessed.capture_id,
        amount: {
          currency_code:
            alreadyProcessed.currency,
          value:
            alreadyProcessed.amount
        },
        early_bird: Boolean(
          alreadyProcessed.early_bird
        ),
        idempotent: true
      });
    }

    const {
      accessToken,
      baseUrl
    } =
      await getPayPalAccessToken();

    let orderData =
      await fetchPayPalOrder(
        baseUrl,
        accessToken,
        orderId
      );

    const product =
      inspectOrder(
        orderData,
        initialState
      );

    /*
     * RECOVERY PATH
     *
     * PayPal may already have captured the money,
     * while a previous Netlify invocation failed
     * before writing the Blob ledger.
     *
     * In that case:
     * - DO NOT capture again
     * - DO NOT require a live reservation
     * - reconcile PayPal truth into our ledger
     */
    if (orderData.status === "COMPLETED") {
      const completedCapture =
        extractCompletedCapture(
          orderData
        );

      if (!completedCapture) {
        throw new Error(
          "PayPal order says COMPLETED but no completed capture exists"
        );
      }

      if (
        completedCapture.currency !==
          product.currency ||
        completedCapture.amount !==
          product.amount
      ) {
        throw new Error(
          "Completed capture amount does not match order"
        );
      }

      const persisted =
        await persistCompletedOrder({
          store,
          orderId,
          captureId:
            completedCapture.captureId,
          amount:
            completedCapture.amount,
          currency:
            completedCapture.currency,
          isEarlyBird:
            product.isEarlyBird,
          reservationId:
            product.reservationId
        });

      return jsonResponse({
        ok: true,
        order_id: orderId,
        status: "COMPLETED",
        capture_id:
          completedCapture.captureId,
        amount: {
          currency_code:
            completedCapture.currency,
          value:
            completedCapture.amount
        },
        early_bird:
          product.isEarlyBird,
        idempotent:
          persisted.alreadyProcessed,
        reconciled: true
      });
    }

    /*
     * NORMAL EARLY BIRD CAPTURE
     *
     * Before new money is captured, the original
     * reservation MUST still be active.
     */
    if (product.isEarlyBird) {
      if (!product.reservationId) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Early Bird order is missing reservation"
          },
          409
        );
      }

      const currentState =
        await store.get(
          "state.json",
          {
            type: "json",
            consistency: "strong"
          }
        );

      const reservation =
        currentState
          ?.early_bird_reservations?.[
            product.reservationId
          ];

      if (!reservation) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Early Bird reservation is no longer active"
          },
          409
        );
      }

      if (
        Date.parse(
          reservation.expires_at
        ) <= Date.now()
      ) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Early Bird reservation has expired"
          },
          409
        );
      }
    }

    if (
      orderData.status !== "APPROVED"
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            `PayPal order is not approved: ${orderData.status}`
        },
        409
      );
    }

    /*
     * NORMAL CAPTURE
     */
    const captureResponse =
      await fetch(
        `${baseUrl}/v2/checkout/orders/${orderId}/capture`,
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
            "Content-Type":
              "application/json"
          }
        }
      );

    /*
     * CONCURRENT/FAILURE RECOVERY
     *
     * If capture request itself reports failure,
     * another invocation may have captured it
     * milliseconds earlier.
     *
     * Re-read PayPal before declaring failure.
     */
    if (!captureResponse.ok) {
      orderData =
        await fetchPayPalOrder(
          baseUrl,
          accessToken,
          orderId
        );

      if (
        orderData.status !== "COMPLETED"
      ) {
        const text =
          await captureResponse.text();

        throw new Error(
          `PayPal capture failed: ${captureResponse.status} ${text}`
        );
      }
    } else {
      /*
       * Capture response was successful.
       * Re-read authoritative PayPal order so
       * both normal and recovery flows use
       * exactly the same validation logic.
       */
      orderData =
        await fetchPayPalOrder(
          baseUrl,
          accessToken,
          orderId
        );
    }

    if (
      orderData.status !== "COMPLETED"
    ) {
      throw new Error(
        `Unexpected PayPal status after capture: ${orderData.status}`
      );
    }

    const completedCapture =
      extractCompletedCapture(
        orderData
      );

    if (!completedCapture) {
      throw new Error(
        "No completed capture found after PayPal capture"
      );
    }

    if (
      completedCapture.currency !==
        product.currency ||
      completedCapture.amount !==
        product.amount
    ) {
      throw new Error(
        "Captured amount does not match order"
      );
    }

    /*
     * Atomically record payment accounting.
     * CAS prevents double sold-counting.
     */
    const persisted =
      await persistCompletedOrder({
        store,
        orderId,
        captureId:
          completedCapture.captureId,
        amount:
          completedCapture.amount,
        currency:
          completedCapture.currency,
        isEarlyBird:
          product.isEarlyBird,
        reservationId:
          product.reservationId
      });

    return jsonResponse({
      ok: true,
      order_id: orderId,
      status: "COMPLETED",
      capture_id:
        completedCapture.captureId,
      amount: {
        currency_code:
          completedCapture.currency,
        value:
          completedCapture.amount
      },
      early_bird:
        product.isEarlyBird,
      idempotent:
        persisted.alreadyProcessed,
      reconciled: false
    });
  } catch (error) {
    console.error(
      "PayPal capture failed:",
      error
    );

    return jsonResponse(
      {
        ok: false,
        error:
          "PayPal capture failed"
      },
      500
    );
  }
};