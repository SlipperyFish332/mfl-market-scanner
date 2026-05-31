require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

const SCAN_INTERVAL = Number(process.env.SCAN_INTERVAL || 30000);

const RULES = {
  minSales: Number(process.env.MIN_SALES || 10),
  minProfit: Number(process.env.MIN_PROFIT || 5),
  minROI: Number(process.env.MIN_ROI || 25)
};

const MFL_API =
  "https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/listings?limit=25&type=PLAYER&sorts=listing.createdDateTime&sortsOrders=DESC&status=AVAILABLE&view=full";

const seenListings = new Set();

app.get("/", (req, res) => {
  res.send("MFL Market Scanner Running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    scanner: "running",
    time: new Date().toISOString()
  });
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function primaryPosition(positionText) {
  if (!positionText) return "";
  return String(positionText).split(/[,/]/)[0].trim().toUpperCase();
}

function extractPlayer(listing) {
  const player = listing.player || {};
  const metadata = player.metadata || listing.metadata || {};

  const firstName = metadata.firstName || player.firstName || "";
  const lastName = metadata.lastName || player.lastName || "";

  const positions =
    metadata.positions ||
    player.positions ||
    listing.positions ||
    metadata.position ||
    "";

  const positionText = Array.isArray(positions)
    ? positions
        .map(p => {
          if (typeof p === "string") return p;
          return p?.name || p?.position || p?.value || "";
        })
        .filter(Boolean)
        .join(", ")
    : String(positions || "");

  const listingId =
    listing.listingResourceId ||
    listing.id ||
    listing.listingId ||
    listing._id ||
    listing.resourceId ||
    `${firstName}-${lastName}-${listing.price}-${metadata.overall}-${metadata.age}`;

  return {
    id: listingId,

    name:
      `${firstName} ${lastName}`.trim() ||
      metadata.name ||
      player.name ||
      "Unknown Player",

    price: Number(listing.price ?? listing.listing?.price ?? listing.listingPrice ?? 0),

    overall: Number(metadata.overall ?? player.overall ?? listing.overall ?? 0),

    age: Number(metadata.age ?? player.age ?? listing.age ?? 0),

    position: primaryPosition(positionText),

    positionText,

    stats: {
      pace: metadata.pace ?? null,
      shooting: metadata.shooting ?? null,
      passing: metadata.passing ?? null,
      dribbling: metadata.dribbling ?? null,
      defense: metadata.defense ?? null,
      physical: metadata.physical ?? null
    },

    url: player.slug
      ? `https://app.playmfl.com/players/${player.slug}`
      : player.id
        ? `https://app.playmfl.com/players/${player.id}`
        : "https://app.playmfl.com/marketplace"
  };
}

async function getMarketValue(player) {
  const res = await axios.post(
    `${SUPABASE_URL}/rest/v1/rpc/get_mfl_market_value`,
    {
      p_overall: player.overall,
      p_age: player.age,
      p_position: player.position
    },
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );

  return Array.isArray(res.data) ? res.data[0] : res.data;
}

function evaluate(player, market) {
  const sales = Number(market?.sales_count || 0);
  const median = Number(market?.median_price || 0);
  const p25 = Number(market?.p25_price || 0);
  const p75 = Number(market?.p75_price || 0);

  if (!sales || sales < RULES.minSales || !median || !p25 || !p75 || !player.price) {
    return {
      notify: false,
      tier: "NO DATA",
      score: 0,
      profit: 0,
      roi: 0,
      sales,
      median,
      p25,
      p75,
      reason: "Not enough comparable sales"
    };
  }

  const profit = Number((median - player.price).toFixed(2));
  const roi = player.price > 0 ? Number(((profit / player.price) * 100).toFixed(1)) : 0;

  const hasMargin =
    profit >= RULES.minProfit &&
    roi >= RULES.minROI &&
    player.price < p25;

  let tier = "AVOID";
  let score = 0;
  let colour = 0xff3b30;
  let notify = false;

  if (hasMargin && player.price <= p25 * 0.7) {
    tier = "S";
    score = 100;
    colour = 0x00ff88;
    notify = true;
  } else if (hasMargin && player.price <= p25 * 0.85) {
    tier = "A";
    score = 88;
    colour = 0x63ff5c;
    notify = true;
  } else if (hasMargin) {
    tier = "B";
    score = 72;
    colour = 0xb8ff3d;
    notify = true;
  }

  return {
    notify,
    tier,
    score,
    colour,
    profit,
    roi,
    sales,
    median,
    p25,
    p75
  };
}

async function sendDiscord(player, result) {
  if (!DISCORD_WEBHOOK) return;

  const stats = Object.entries(player.stats)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key.toUpperCase()} ${value}`)
    .join(" · ");

  const embed = {
    title: `🚨 ${result.tier}-Tier MFL Flip Found`,
    url: player.url,
    color: result.colour,
    fields: [
      { name: "Player", value: player.name, inline: true },
      { name: "Price", value: `$${player.price}`, inline: true },
      { name: "Expected Profit", value: `$${result.profit} (${result.roi}%)`, inline: true },
      { name: "OVR", value: String(player.overall), inline: true },
      { name: "Age", value: String(player.age), inline: true },
      { name: "Position", value: player.positionText || player.position, inline: true },
      { name: "Median", value: `$${result.median}`, inline: true },
      { name: "P25 / P75", value: `$${result.p25} / $${result.p75}`, inline: true },
      { name: "Comparable Sales", value: String(result.sales), inline: true }
    ],
    footer: {
      text: "MFL Market Scanner"
    },
    timestamp: new Date().toISOString()
  };

  if (stats) {
    embed.fields.push({
      name: "Stats",
      value: stats,
      inline: false
    });
  }

  await axios.post(
    DISCORD_WEBHOOK,
    {
      username: "MFL Market Scanner",
      embeds: [embed]
    },
    {
      timeout: 15000
    }
  );
}

async function scanMarketplace() {
  console.log(`[${new Date().toLocaleTimeString()}] Scanning MFL marketplace...`);

  try {
    const res = await axios.get(MFL_API, { timeout: 15000 });

    const listings = Array.isArray(res.data)
      ? res.data
      : res.data.listings || res.data.data || res.data.results || [];

    console.log(`Found ${listings.length} listings`);

    for (const listing of listings) {
      const player = extractPlayer(listing);

      if (!player.id || seenListings.has(player.id)) continue;

      seenListings.add(player.id);

      if (!player.price || !player.overall || !player.age || !player.position) {
        console.log(`Skipping incomplete listing: ${player.name}`);
        continue;
      }

      const market = await getMarketValue(player);
      const result = evaluate(player, market);

      console.log(
        `${player.name} | ${player.overall} OVR | ${player.age} | ${player.position} | Listed $${player.price} | ${result.tier} | Profit $${result.profit || 0} | ROI ${result.roi || 0}%`
      );

      if (result.notify) {
        await sendDiscord(player, result);
        console.log(`🚨 Discord alert sent: ${player.name}`);
      }

      await sleep(150);
    }

    while (seenListings.size > 1000) {
      seenListings.delete(seenListings.values().next().value);
    }
  } catch (err) {
    console.error("Scan error:", err.message);
  }
}

async function startScanner() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  }

  console.log("======================================");
  console.log("MFL Market Scanner Started");
  console.log(`Scan interval: ${SCAN_INTERVAL}ms`);
  console.log(`Min sales: ${RULES.minSales}`);
  console.log(`Min profit: $${RULES.minProfit}`);
  console.log(`Min ROI: ${RULES.minROI}%`);
  console.log("======================================");

  await scanMarketplace();

  setInterval(scanMarketplace, SCAN_INTERVAL);
}

app.listen(PORT, () => {
  console.log(`✅ Web server running on port ${PORT}`);
  startScanner().catch(err => {
    console.error("Scanner startup error:", err.message);
  });
});
