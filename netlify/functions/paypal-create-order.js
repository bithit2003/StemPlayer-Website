import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
async function getPayPalAccessToken() {
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

  const basicAuth = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
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

export default async () => {
  try {

    const store = getStore({
    name: "stemplayer-commerce",
    consistency: "strong"
    });

    let reservation = null;
    let isEarlyBird = false;
    let earlyBirdRemaining = 0;

    for (let attempt = 0; attempt < 5; attempt++) {
    const result = await store.getWithMetadata("state.json", {
        type: "json",
        consistency: "strong"
    });

    if (!result?.data) {
        throw new Error("Commerce state not initialized");
    }

    const currentState = result.data;
    const etag = result.etag;

    const sold =
        currentState.early_bird_sold ??
        currentState.early_bird_used ??
        0;

    const now = Date.now();

    const activeReservations = Object.fromEntries(
    Object.entries(
        currentState.early_bird_reservations ?? {}
    ).filter(([, item]) => {
        const expiresAt = Date.parse(item.expires_at);
        return Number.isFinite(expiresAt) && expiresAt > now;
    })
    );

    const reserved = Object.keys(
    activeReservations
    ).length;

    earlyBirdRemaining = Math.max(
    0,
    currentState.early_bird_limit - sold - reserved
    );

    if (earlyBirdRemaining <= 0) {
        break;
    }

    const reservationId = crypto.randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(
        createdAt.getTime() + 30 * 60 * 1000
    );

    const reservations = {
        ...activeReservations,
        [reservationId]: {
        created_at: createdAt.toISOString(),
        expires_at: expiresAt.toISOString()
        }
    };

    const nextState = {
        ...currentState,
        early_bird_sold: sold,
        early_bird_reserved: reserved + 1,
        early_bird_reservations: reservations
    };

    delete nextState.early_bird_used;

    const writeResult = await store.setJSON(
        "state.json",
        nextState,
        {
        onlyIfMatch: etag
        }
    );

    if (writeResult.modified) {
        reservation = {
        id: reservationId,
        expires_at: expiresAt.toISOString()
        };

        isEarlyBird = true;
        earlyBirdRemaining -= 1;
        break;
    }

    if (attempt === 4) {
        throw new Error(
        "Unable to reserve Early Bird slot"
        );
    }
    }

    const state = await store.get("state.json", {
    type: "json",
    consistency: "strong"
    });

    const amount = isEarlyBird
    ? state.early_bird_price_usd
    : state.regular_price_usd;

    const referenceId = isEarlyBird
    ? "STEMPLAYER_V2_EARLY_BIRD"
    : "STEMPLAYER_V2_STANDARD";

    const description = isEarlyBird
    ? "StemPlayer V2 - Early Bird License"
    : "StemPlayer V2 - Standard License";

    const { accessToken, baseUrl } = await getPayPalAccessToken();

    const orderResponse = await fetch(
      `${baseUrl}/v2/checkout/orders`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          intent: "CAPTURE",
        purchase_units: [
        {
            reference_id: referenceId,
            ...(reservation?.id
            ? { custom_id: reservation.id }
            : {}),
            description,
            amount: {
            currency_code: "USD",
            value: amount
            }
        }
        ],
          application_context: {
            brand_name: "StemPlayer",
            landing_page: "NO_PREFERENCE",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING"
          }
        })
      }
    );

    const orderData = await orderResponse.json();

    if (!orderResponse.ok && reservation?.id) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const result = await store.getWithMetadata("state.json", {
        type: "json",
        consistency: "strong"
        });

        if (!result?.data) {
        break;
        }

        const currentState = result.data;
        const reservations = {
        ...(currentState.early_bird_reservations ?? {})
        };

        if (!reservations[reservation.id]) {
        break;
        }

        delete reservations[reservation.id];

        const nextState = {
        ...currentState,
        early_bird_reserved: Object.keys(reservations).length,
        early_bird_reservations: reservations
        };

        const writeResult = await store.setJSON(
        "state.json",
        nextState,
        {
            onlyIfMatch: result.etag
        }
        );

        if (writeResult.modified) {
        break;
        }
    }
    }

    if (!orderResponse.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          paypal_status: orderResponse.status,
          error: "PayPal order creation failed",
          details: orderData
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const approvalLink =
      orderData.links?.find(
        link =>
          link.rel === "approve" ||
          link.rel === "payer-action"
      )?.href || null;

    return new Response(
      JSON.stringify({
        ok: true,
        order_id: orderData.id,
        status: orderData.status,
        amount,
        currency: "USD",
        product: isEarlyBird
        ? "StemPlayer V2 Early Bird"
        : "StemPlayer V2",
        early_bird: isEarlyBird,
        early_bird_remaining: earlyBirdRemaining,
        approval_url: approvalLink
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (error) {
    console.error("paypal-create-order failed:", error);
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Unexpected server error"
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};