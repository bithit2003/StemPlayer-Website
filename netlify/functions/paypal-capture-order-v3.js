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

function inspectOrder(orderData) {
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

  const upgradeLicenseId =
    purchaseUnit.custom_id ?? null;

  let offer;
  let expectedAmount;

  if (
    referenceId ===
    "STEMPLAYER_V3_STANDARD"
  ) {
    offer = "standard";
    expectedAmount = "29.99";
  } else if (
    referenceId ===
    "STEMPLAYER_V3_UPGRADE"
  ) {
    offer = "upgrade";
    expectedAmount = "20.00";

    if (
      !upgradeLicenseId ||
      !upgradeLicenseId.startsWith("SPV2-")
    ) {
      throw new Error(
        "Missing V2 upgrade entitlement"
      );
    }
  } else {
    throw new Error(
      "Unexpected StemPlayer V3 product reference"
    );
  }

  if (
    currency !== "USD" ||
    orderAmount !== expectedAmount
  ) {
    throw new Error(
      "Unexpected PayPal order amount"
    );
  }

  return {
    edition: "V3",
    offer,
    upgradeLicenseId:
      offer === "upgrade"
        ? upgradeLicenseId
        : null,
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
  product
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
     * accounting for this exact V3 order.
     */
    if (existing?.payment_processed) {
      if (
        existing.edition !== "V3" ||
        existing.capture_id !== captureId
      ) {
        throw new Error(
          "V3 order ledger mismatch"
        );
      }

      return {
        alreadyProcessed: true,
        record: existing
      };
    }

    /*
     * Shared processed_orders also contains
     * legacy V2 records. Never overwrite one.
     */
    if (existing) {
      throw new Error(
        "Order ledger already contains a non-V3 payment record"
      );
    }

    processedOrders[orderId] = {
      capture_id: captureId,
      amount,
      currency,
      edition: "V3",
      offer: product.offer,
      payment_processed: true,
      upgrade_from:
        product.offer === "upgrade"
          ? {
              edition: "V2",
              license_id:
                product.upgradeLicenseId
            }
          : null,
      license: null
    };

    /*
     * Preserve the entire existing state.
     * V3 must not mutate V2 Early Bird fields.
     */
    const nextState = {
      ...state,
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

  if (
    finalRecord?.payment_processed &&
    finalRecord.edition === "V3"
  ) {
    return {
      alreadyProcessed: true,
      record: finalRecord
    };
  }

  throw new Error(
    "Unable to persist completed V3 PayPal order"
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

if (
  alreadyProcessed?.payment_processed &&
  alreadyProcessed.edition === "V3"
) {
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
    edition: "V3",
    offer:
      alreadyProcessed.offer,
    upgrade_from:
      alreadyProcessed.upgrade_from ??
      null,
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
      inspectOrder(orderData);

    /*
     * RECOVERY PATH
     *
     * PayPal may already have captured the money,
     * while a previous invocation failed
     * before writing the Blob ledger.
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
          product
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
        edition: "V3",
        offer: product.offer,
        upgrade_from:
          product.offer === "upgrade"
            ? {
                edition: "V2",
                license_id:
                  product.upgradeLicenseId
              }
            : null,
        idempotent:
          persisted.alreadyProcessed,
        reconciled: true
      });
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
     * Atomically record V3 payment.
     * CAS prevents duplicate processing.
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
        product
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
      edition: "V3",
      offer: product.offer,
      upgrade_from:
        product.offer === "upgrade"
          ? {
              edition: "V2",
              license_id:
                product.upgradeLicenseId
            }
          : null,
      idempotent:
        persisted.alreadyProcessed,
      reconciled: false
    });
  } catch (error) {
    console.error(
      "PayPal V3 capture failed:",
      error
    );

    return jsonResponse(
      {
        ok: false,
        error:
          "PayPal V3 capture failed"
      },
      500
    );
  }
};