import { getStore } from "@netlify/blobs";

const STORE_NAME = "stemplayer-commerce";
const STATE_KEY = "state.json";

const DEFAULT_STATE = {
  early_bird_limit: 30,
  early_bird_sold: 0,
  early_bird_reserved: 0,
  early_bird_price_usd: "5.00",
  regular_price_usd: "9.99"
};

export default async () => {
  try {
    const store = getStore({
      name: STORE_NAME,
      consistency: "strong"
    });

    let state = await store.get(STATE_KEY, {
      type: "json",
      consistency: "strong"
    });

    if (!state) {
      await store.setJSON(STATE_KEY, DEFAULT_STATE, {
        onlyIfNew: true
      });

      state = await store.get(STATE_KEY, {
        type: "json",
        consistency: "strong"
      });
    }

    const sold =
      state.early_bird_sold ??
      state.early_bird_used ??
      0;

    const now = Date.now();

    const activeReservations = Object.values(
      state.early_bird_reservations ?? {}
    ).filter(item => {
      const expiresAt = Date.parse(item.expires_at);
      return Number.isFinite(expiresAt) && expiresAt > now;
    });

    const reserved =
      state.early_bird_reservations
        ? activeReservations.length
        : state.early_bird_reserved ?? 0;

    const remaining = Math.max(
      0,
      state.early_bird_limit - sold - reserved
    );

    const active = remaining > 0;

    return Response.json(
      {
        ok: true,
        early_bird: {
          active,
          limit: state.early_bird_limit,
          sold,
          reserved,
          remaining
        },
        pricing: {
          current_usd: active
            ? state.early_bird_price_usd
            : state.regular_price_usd,
          early_bird_usd: state.early_bird_price_usd,
          regular_usd: state.regular_price_usd
        }
      },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    console.error("commerce-status failed:", error);

    return Response.json(
      {
        ok: false,
        error: "Unable to load commerce status"
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  }
};