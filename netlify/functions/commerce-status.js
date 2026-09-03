const { getStore } = require("@netlify/blobs");

const STORE_NAME = "stemplayer-commerce";
const STATE_KEY = "state.json";

const DEFAULT_STATE = {
  early_bird_limit: 30,
  early_bird_used: 0,
  early_bird_price_usd: "5.00",
  regular_price_usd: "9.99"
};

exports.handler = async function () {
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
      const result = await store.setJSON(
        STATE_KEY,
        DEFAULT_STATE,
        { onlyIfNew: true }
      );

      state = DEFAULT_STATE;
    }

    const earlyBirdRemaining = Math.max(
      0,
      state.early_bird_limit - state.early_bird_used
    );

    const earlyBirdActive = earlyBirdRemaining > 0;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        ok: true,
        early_bird: {
          active: earlyBirdActive,
          limit: state.early_bird_limit,
          used: state.early_bird_used,
          remaining: earlyBirdRemaining
        },
        pricing: {
          current_usd: earlyBirdActive
            ? state.early_bird_price_usd
            : state.regular_price_usd,
          early_bird_usd: state.early_bird_price_usd,
          regular_usd: state.regular_price_usd
        }
      })
    };
  } catch (error) {
    console.error("commerce-status failed:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        ok: false,
        error: "Unable to load commerce status"
      })
    };
  }
};