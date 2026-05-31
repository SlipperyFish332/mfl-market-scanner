import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ===========================
// CONFIG
// ===========================

const SCAN_INTERVAL = 30000;
const MIN_PROFIT = -5;
const MIN_ROI = 25;
const MIN_SALES = 10;

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ===========================
// HEALTH ROUTE
// ===========================

app.get("/", (req, res) => {
  res.send("MFL Scanner Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    scanner: "running"
  });
});

// ===========================
// MARKET VALUE
// ===========================

async function getMarketValue(ovr, age, position) {
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/rpc/get_mfl_market_value`;

    const response = await axios.post(
      url,
      {
        p_ovr: ovr,
        p_age: age,
        p_position: position
      },
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return response.data?.[0] || null;
  } catch (err) {
    console.error("Supabase error:", err.message);
    return null;
  }
}

// ===========================
// DISCORD ALERT
// ===========================

async function sendDiscordAlert(player, score) {
  if (!DISCORD_WEBHOOK) return;

  try {
    await axios.post(DISCORD_WEBHOOK, {
      content:
`🚨 **GOOD VALUE FOUND**

**${player.name}**
OVR: ${player.ovr}
Age: ${player.age}
Position: ${player.position}

Price: $${player.price}
Median: $${score.median_price}

Profit: $${score.profit}
ROI: ${score.roi}%`
    });

    console.log(`Discord alert sent for ${player.name}`);
  } catch (err) {
    console.error("Discord webhook error:", err.message);
  }
}

// ===========================
// SCORE PLAYER
// ===========================

function scorePlayer(player, market) {
  const median = market.median_price || 0;

  const profit = +(median - player.price).toFixed(2);

  const roi =
    median > 0
      ? +((profit / player.price) * 100).toFixed(1)
      : 0;

  return {
    profit,
    roi,
    median_price: median,
    sales_count: market.sales_count
  };
}

// ===========================
// MOCK MARKET SCAN
// Replace later with real API
// ===========================

async function scanMarketplace() {
  console.log(
    `[${new Date().toLocaleTimeString()}] Scanning MFL marketplace...`
  );

  // mock player for now
  const players = [
    {
      name: "Test Player",
      ovr: 73,
      age: 32,
      position: "ST",
      price: 3
    }
  ];

  console.log(`Found ${players.length} listings`);

  for (const player of players) {
    const market = await getMarketValue(
      player.ovr,
      player.age,
      player.position
    );

    if (!market) continue;

    const score = scorePlayer(player, market);

    const verdict =
      score.roi >= MIN_ROI &&
      score.profit >= MIN_PROFIT &&
      market.sales_count >= MIN_SALES
        ? "BUY"
        : "AVOID";

    console.log(
      `${player.name} | ${player.ovr} OVR | ${player.age} | ${player.position} | Listed $${player.price} | ${verdict} | Profit $${score.profit} | ROI ${score.roi}%`
    );

    if (verdict === "BUY") {
      await sendDiscordAlert(player, score);
    }
  }
}

// ===========================
// START SCANNER
// ===========================

console.log("==================================");
console.log("MFL Market Scanner Started");
console.log("==================================");

console.log("Scan interval:", SCAN_INTERVAL);
console.log("Min sales:", MIN_SALES);
console.log("Min profit:", MIN_PROFIT);
console.log("Min ROI:", MIN_ROI);

setInterval(scanMarketplace, SCAN_INTERVAL);
scanMarketplace();

// ===========================
// THIS IS THE FIX
// ===========================

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});
