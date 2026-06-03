require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

const SCAN_INTERVAL = Number(process.env.SCAN_INTERVAL || 30000);

const API_BASE = "https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod";

const PLAYER_API =
  `${API_BASE}/listings?limit=25&type=PLAYER&sorts=listing.createdDateTime&sortsOrders=DESC&status=AVAILABLE&view=full&hideNearRetirement=true`;

const CLUB_API =
  `${API_BASE}/listings?limit=25&type=CLUB&sorts=listing.createdDateTime&sortsOrders=DESC&status=AVAILABLE&view=full`;

const RULES = {
  minSales: Number(process.env.MIN_SALES || 5),
  minProfit: Number(process.env.MIN_PROFIT || 1),
  minROI: Number(process.env.MIN_ROI || 10)
};

const CLUB_SETTINGS = {
  requestDelayMs: 100,
  recentSalesDays: 60,
  liveSalesLimit: 5000,
  mflToUsdDivisor: 400,
  minSalePrice: 1,
  maxOverWorthMultiple: 1.5,
  alertGrades: ["A+", "A"]
};

const DIVISION_NUMBER_MAP = {
  1: "Diamond",
  2: "Platinum",
  3: "Gold",
  4: "Silver",
  5: "Bronze",
  6: "Iron",
  7: "Stone",
  8: "Ice",
  9: "Spark",
  10: "Flint"
};

const DIVISION_ORDER = [
  "Diamond",
  "Platinum",
  "Gold",
  "Silver",
  "Bronze",
  "Iron",
  "Stone",
  "Ice",
  "Spark",
  "Flint"
];

const DIVISION_BASE_PRICE = {
  Diamond: 1500,
  Platinum: 750,
  Gold: 361.3,
  Silver: 168.8,
  Bronze: 97.3,
  Iron: 63.5,
  Stone: 68.0,
  Ice: 56.4,
  Spark: 52.8,
  Flint: 55.8
};

const LAST_PLACE_MFL = {
  Diamond: 400000,
  Platinum: 190000,
  Gold: 92000,
  Silver: 44000,
  Bronze: 21500,
  Iron: 10000,
  Stone: 4900,
  Ice: 2350,
  Spark: 1150,
  Flint: 550
};

const seenPlayerListings = new Set();
const seenClubListings = new Set();

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Web server running on port ${PORT}`);

  startScanner().catch(err => {
    console.error("Scanner startup error:", err.message);
  });
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function primaryPosition(positionText) {
  if (!positionText) return "";
  return String(positionText).split(/[,/]/)[0].trim().toUpperCase();
}

async function supabasePost(path, body) {
  const res = await axios.post(`${SUPABASE_URL}${path}`, body, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 15000
  });

  return res.data;
}

async function supabaseGet(path) {
  const res = await axios.get(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    },
    timeout: 15000
  });

  return res.data;
}

async function fetchMflJson(url) {
  await sleep(CLUB_SETTINGS.requestDelayMs);
  const res = await axios.get(url, { timeout: 15000 });
  return res.data;
}

// =======================
// PLAYER SCANNER
// =======================

function detectNearRetirement(listing, player, metadata) {
  const checks = [
    listing?.isNearRetirement,
    listing?.nearRetirement,
    listing?.retiring,
    listing?.isRetiring,
    listing?.willRetire,
    listing?.retirement,
    listing?.retirementStatus,

    player?.isNearRetirement,
    player?.nearRetirement,
    player?.retiring,
    player?.isRetiring,
    player?.willRetire,
    player?.retirement,
    player?.retirementStatus,

    metadata?.isNearRetirement,
    metadata?.nearRetirement,
    metadata?.retiring,
    metadata?.isRetiring,
    metadata?.willRetire,
    metadata?.retirement,
    metadata?.retirementStatus
  ];

  return checks.some(value => {
    if (value === true) return true;

    if (typeof value === "string") {
      const text = value.toLowerCase();
      return (
        text.includes("retir") ||
        text.includes("near retirement") ||
        text.includes("near-retirement")
      );
    }

    return false;
  });
}

function extractPlayer(listing) {
  const player = listing.player || listing.resource || {};
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

  const playerId =
    player.id ||
    player.playerId ||
    metadata.id ||
    metadata.playerId ||
    listing.playerId ||
    null;

  return {
    id: String(listingId),
    playerId: playerId ? String(playerId) : null,

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

    isNearRetirement: detectNearRetirement(listing, player, metadata),

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
  const data = await supabasePost("/rest/v1/rpc/get_mfl_market_value", {
    p_overall: player.overall,
    p_age: player.age,
    p_position: player.position
  });

  return Array.isArray(data) ? data[0] : data;
}

async function cleanupOldPlayerAlerts() {
  try {
    await supabasePost("/rest/v1/rpc/cleanup_old_mfl_alerts", {});
  } catch (err) {
    console.error("Player cleanup error:", err.message);
  }
}

async function alreadyAlertedPlayer(player) {
  const listingId = encodeURIComponent(player.id);
  const price = encodeURIComponent(player.price);

  const data = await supabaseGet(
    `/rest/v1/mfl_alerted_listings?select=id&listing_id=eq.${listingId}&listed_price=eq.${price}&limit=1`
  );

  return Array.isArray(data) && data.length > 0;
}

async function savePlayerAlert(player, result) {
  await supabasePost("/rest/v1/mfl_alerted_listings", {
    listing_id: player.id,
    player_id: player.playerId,
    player_name: player.name,
    listed_price: player.price,
    overall: player.overall,
    age: player.age,
    position: player.position,
    tier: result.tier,
    profit: result.profit,
    roi: result.roi
  });
}

function evaluatePlayer(player, market) {
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
      p75
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

async function sendPlayerDiscord(player, result) {
  if (!DISCORD_WEBHOOK) return;

  const stats = Object.entries(player.stats)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key.toUpperCase()} ${value}`)
    .join(" · ");

  const embed = {
    title: `🚨 ${result.tier}-Tier MFL Player Flip Found`,
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
      text: "MFL Player Market Scanner"
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
      username: "MFL Player Scanner",
      embeds: [embed]
    },
    {
      timeout: 15000
    }
  );
}

async function scanPlayerMarketplace() {
  console.log(`[${new Date().toLocaleTimeString()}] Scanning MFL player marketplace...`);

  try {
    await cleanupOldPlayerAlerts();

    const res = await axios.get(PLAYER_API, { timeout: 15000 });

    const listings = Array.isArray(res.data)
      ? res.data
      : res.data.listings || res.data.data || res.data.results || [];

    console.log(`Found ${listings.length} player listings`);

    for (const listing of listings) {
      const player = extractPlayer(listing);

      if (!player.id || seenPlayerListings.has(player.id)) continue;

      seenPlayerListings.add(player.id);

      if (player.isNearRetirement) {
        console.log(
          `SKIPPED NEAR RETIREMENT PLAYER: ${player.name} | ${player.overall} OVR | Age ${player.age} | Listed $${player.price}`
        );
        continue;
      }

      if (!player.price || !player.overall || !player.age || !player.position) {
        console.log(`Skipping incomplete player listing: ${player.name}`);
        continue;
      }

      const market = await getMarketValue(player);
      const result = evaluatePlayer(player, market);

      console.log(
        `${player.name} | ${player.overall} OVR | ${player.age} | ${player.position} | Listed $${player.price} | ${result.tier} | Profit $${result.profit || 0} | ROI ${result.roi || 0}%`
      );

      if (result.notify) {
        const seen = await alreadyAlertedPlayer(player);

        if (seen) {
          console.log(`Already alerted player, skipping Discord: ${player.name} @ $${player.price}`);
        } else {
          await sendPlayerDiscord(player, result);
          await savePlayerAlert(player, result);
          console.log(`🚨 Player Discord alert sent and saved: ${player.name}`);
        }
      }

      await sleep(150);
    }

    while (seenPlayerListings.size > 1000) {
      seenPlayerListings.delete(seenPlayerListings.values().next().value);
    }
  } catch (err) {
    console.error("Player scan error:", err.message);
  }
}

// =======================
// CLUB SCANNER
// =======================

function roundUpToNearest005(value) {
  return Math.ceil(Number(value || 0) * 20) / 20;
}

function parseRewardAmount(lines) {
  if (!lines || !lines.length) return 0;
  const match = String(lines[0]).match(/[\d.]+/);
  return match ? Number(match[0]) : 0;
}

function parseDivisionFromLeagueName(name) {
  if (!name) return null;
  const division = String(name).split(/–|-/)[0].trim();
  return DIVISION_BASE_PRICE[division] !== undefined ? division : null;
}

async function cleanupOldClubAlerts() {
  try {
    await supabasePost("/rest/v1/rpc/cleanup_old_mfl_club_alerts", {});
  } catch (err) {
    console.error("Club cleanup error:", err.message);
  }
}

async function loadLiveDivisionPrices() {
  try {
    const sinceDate = new Date(
      Date.now() - CLUB_SETTINGS.recentSalesDays * 24 * 60 * 60 * 1000
    ).toISOString();

    const path =
      `/rest/v1/mfl_transfers_clubs?select=price,club_division,type,purchase_date,status` +
      `&purchase_date=gte.${encodeURIComponent(sinceDate)}` +
      `&order=purchase_date.desc,id.asc` +
      `&limit=${CLUB_SETTINGS.liveSalesLimit}`;

    const data = await supabaseGet(path);

    const grouped = {};

    for (const row of data || []) {
      if (row.status !== "BOUGHT") continue;

      const price = Number(row.price);
      if (!price || price < CLUB_SETTINGS.minSalePrice) continue;

      const divisionName = DIVISION_NUMBER_MAP[Number(row.club_division)];
      if (!divisionName) continue;

      if (!grouped[divisionName]) grouped[divisionName] = [];
      grouped[divisionName].push(price);
    }

    for (const division of Object.keys(grouped)) {
      const prices = grouped[division].sort((a, b) => a - b);
      const mid = Math.floor(prices.length / 2);

      const median =
        prices.length % 2
          ? prices[mid]
          : (prices[mid - 1] + prices[mid]) / 2;

      DIVISION_BASE_PRICE[division] = Number(median.toFixed(1));
    }

    console.log("Club live division prices loaded:", DIVISION_BASE_PRICE);
  } catch (err) {
    console.error("Failed to load live club prices. Using fallback prices.", err.message);
  }
}

function sortLeagueMembers(members) {
  return [...(members || [])].sort((a, b) => {
    if (Number(b.points || 0) !== Number(a.points || 0)) {
      return Number(b.points || 0) - Number(a.points || 0);
    }

    const gdA = Number(a.goals || 0) - Number(a.goalsAgainst || 0);
    const gdB = Number(b.goals || 0) - Number(b.goalsAgainst || 0);

    if (gdB !== gdA) return gdB - gdA;
    return Number(b.goals || 0) - Number(a.goals || 0);
  });
}

function getLeagueRank(members, clubId) {
  const sorted = sortLeagueMembers(members);
  const numericClubId = Number(clubId);
  const idx = sorted.findIndex(m => Number(m.clubId) === numericClubId);

  if (idx === -1) return null;

  const club = sorted[idx];
  const clubGD = Number(club.goals || 0) - Number(club.goalsAgainst || 0);

  const tiedIndices = sorted
    .map((m, i) => ({ m, i }))
    .filter(({ m }) =>
      Number(m.points || 0) === Number(club.points || 0) &&
      Number(m.goals || 0) - Number(m.goalsAgainst || 0) === clubGD &&
      Number(m.goals || 0) === Number(club.goals || 0)
    )
    .map(({ i }) => i);

  return Math.max(...tiedIndices) + 1;
}

function rankMatchesReward(rewardRanks, rank) {
  if (String(rewardRanks).includes("-")) {
    const [min, max] = String(rewardRanks).split("-").map(Number);
    return rank >= min && rank <= max;
  }

  const n = parseInt(rewardRanks, 10);
  return !isNaN(n) && n === rank;
}

function getLeagueReward(competition, clubId) {
  const members = competition?.schedule?.stages?.[0]?.groups?.[0]?.members || [];
  const rank = getLeagueRank(members, clubId);

  if (rank === null) return 0;

  for (const reward of competition.rewards || []) {
    if (rankMatchesReward(reward.ranks, rank)) {
      return parseRewardAmount(reward.lines);
    }
  }

  return 0;
}

function getCupGroupWins(competition, clubId) {
  const numericClubId = Number(clubId);

  for (const group of competition?.schedule?.stages?.[0]?.groups || []) {
    const member = group.members?.find(m => Number(m.clubId) === numericClubId);
    if (member) return Number(member.wins || 0);
  }

  return 0;
}

function getCupGroupWinPrize(competition) {
  const reward = (competition.rewards || []).find(r => r.ranks === "Group Stage Win");
  return reward ? parseRewardAmount(reward.lines) : 0;
}

function getKnockoutRank(stages, clubId) {
  const numericClubId = Number(clubId);
  const knockoutStage = (stages || []).find(s => Array.isArray(s.rounds));

  if (!knockoutStage) return null;

  const roundToRank = {
    "Round of 16": "Round of 16",
    Quarterfinals: "Quarterfinalists",
    Semifinals: "Semifinalists"
  };

  for (const round of knockoutStage.rounds) {
    const match = (round.matches || []).find(
      m => Number(m.homeClubId) === numericClubId || Number(m.awayClubId) === numericClubId
    );

    if (!match) continue;

    if (match.status !== "ENDED") {
      return round.name === "Final"
        ? "Runner-up"
        : roundToRank[round.name] || round.name;
    }

    const isHome = Number(match.homeClubId) === numericClubId;
    const homeGoals = Number(match.homeScore || 0);
    const awayGoals = Number(match.awayScore || 0);

    const homeWon = homeGoals !== awayGoals
      ? homeGoals > awayGoals
      : Number(match.homePenaltyScore || 0) > Number(match.awayPenaltyScore || 0);

    const clubWon = isHome ? homeWon : !homeWon;

    if (!clubWon) {
      return round.name === "Final"
        ? "Runner-up"
        : roundToRank[round.name] || round.name;
    }

    if (round.name === "Final") return "Winner";
  }

  return null;
}

function getCupPlacementReward(competition, clubId) {
  const rank = getKnockoutRank(competition?.schedule?.stages || [], clubId);
  if (!rank) return 0;

  const reward = (competition.rewards || []).find(r => r.ranks === rank);
  return reward ? parseRewardAmount(reward.lines) : 0;
}

function getCupReward(competition, clubId) {
  const placementReward = getCupPlacementReward(competition, clubId);
  const winPrize = getCupGroupWinPrize(competition);
  const wins = getCupGroupWins(competition, clubId);
  return placementReward + wins * winPrize;
}

async function fetchClubCompetitions(clubId) {
  const data = await fetchMflJson(`${API_BASE}/clubs/${clubId}/competitions`);
  const items = Array.isArray(data) ? data : data.competitions || data.items || [];

  const live = items.filter(c => c.status === "LIVE");

  const league = live.find(c => c.type === "LEAGUE");
  const cup = live.find(c => c.type === "CUP");

  if (!league) {
    throw new Error(`No live league for club ${clubId}`);
  }

  return {
    leagueId: league.id,
    cupId: cup?.id || null
  };
}

async function fetchContracts(clubId) {
  const data = await fetchMflJson(`${API_BASE}/contracts?period=currentSeason&clubId=${clubId}`);
  return Array.isArray(data) ? data : data.items || data.contracts || [];
}

function getContractDeductionMultiplier(contracts) {
  const active = (contracts || []).filter(c => c.status === "ACTIVE");

  return active
    .filter(c => c.type === "PLAYER" || c.type === "MANAGER")
    .reduce((sum, c) => sum + (Number(c.revenueShare) || 0), 0) / 10000;
}

function getExitDivisions(startDivision) {
  const startIndex = DIVISION_ORDER.indexOf(startDivision);
  const sparkIndex = DIVISION_ORDER.indexOf("Spark");

  if (startDivision === "Flint") return ["Flint"];
  if (startIndex === -1 || sparkIndex === -1) return [];
  if (startIndex >= sparkIndex) return ["Spark"];

  return DIVISION_ORDER.slice(startIndex + 1, sparkIndex + 1);
}

function calculateExitAnalysis({ division, listPrice }) {
  const exitDivisions = getExitDivisions(division);
  const exits = [];

  let cumulativeMfl = 0;

  for (const exitDivision of exitDivisions) {
    if (division === "Flint") {
      cumulativeMfl += LAST_PLACE_MFL.Flint || 0;
    } else {
      const currentExitIndex = DIVISION_ORDER.indexOf(exitDivision);
      const previousDivision = DIVISION_ORDER[currentExitIndex - 1];

      cumulativeMfl += LAST_PLACE_MFL[previousDivision] || 0;
    }

    const seasonsHeld = exits.length + 1;
    const mflValue = cumulativeMfl / CLUB_SETTINGS.mflToUsdDivisor;
    const saleValue = DIVISION_BASE_PRICE[exitDivision] || 0;
    const totalValue = mflValue + saleValue;
    const profit = totalValue - listPrice;
    const roi = listPrice > 0 ? profit / listPrice : 0;
    const roiPerSeason = seasonsHeld > 0 ? roi / seasonsHeld : 0;

    exits.push({
      exitDivision,
      seasonsHeld,
      cumulativeMfl,
      mflValue,
      saleValue,
      totalValue,
      profit,
      roi,
      roiPercent: roi * 100,
      roiPerSeason,
      roiPerSeasonPercent: roiPerSeason * 100
    });

    if (division === "Flint") break;
  }

  let optimalExit = null;

  for (const exit of exits) {
    if (!optimalExit || exit.roiPerSeason > optimalExit.roiPerSeason) {
      optimalExit = exit;
    }
  }

  return {
    exits,
    optimalExit
  };
}

function getInvestmentDecision({ valueGap, listPrice, fairPrice, optimalExit }) {
  const valueGapPct = listPrice > 0 ? valueGap / listPrice : 0;
  const roiPerSeason = optimalExit?.roiPerSeason || 0;
  const profit = optimalExit?.profit || 0;

  if (listPrice > fairPrice * CLUB_SETTINGS.maxOverWorthMultiple) {
    return {
      label: "🔴 D AVOID",
      grade: "D",
      score: 0,
      reason: "Listed far above current worth"
    };
  }

  if (profit <= 0 || roiPerSeason <= 0) {
    return {
      label: "🔴 D AVOID",
      grade: "D",
      score: 10,
      reason: "No profitable optimal exit"
    };
  }

  let score = 0;

  score += Math.min(Math.max(roiPerSeason * 200, 0), 45);
  score += Math.min(Math.max(valueGapPct * 100, -50), 25);

  if (profit > 0) score += 15;
  if (roiPerSeason > 0.15) score += 10;

  score = Math.max(0, Math.min(100, Math.round(score + 30)));

  if (score >= 85 && roiPerSeason >= 0.20 && valueGapPct >= -0.10) {
    return {
      label: "🔥 A+ BUY",
      grade: "A+",
      score,
      reason: "Strong value and optimal exit"
    };
  }

  if (score >= 70 && roiPerSeason >= 0.12 && valueGapPct >= -0.20) {
    return {
      label: "🟢 A BUY",
      grade: "A",
      score,
      reason: "Positive optimal exit strategy"
    };
  }

  if (score >= 55 && roiPerSeason >= 0.05) {
    return {
      label: "🟢 B WATCH",
      grade: "B",
      score,
      reason: "Potentially viable"
    };
  }

  if (score >= 40 && roiPerSeason >= 0) {
    return {
      label: "🟡 C FAIR",
      grade: "C",
      score,
      reason: "Fair but not compelling"
    };
  }

  return {
    label: "🔴 D AVOID",
    grade: "D",
    score,
    reason: "Weak risk-adjusted return"
  };
}

function extractClubListing(listing) {
  const club = listing.club || listing.resource || listing.metadata || {};
  const metadata = listing.metadata || club.metadata || {};

  const listingId =
    listing.listingResourceId ||
    listing.id ||
    listing.listingId ||
    listing._id ||
    listing.resourceId ||
    `${club.id || metadata.id}-${listing.price}`;

  const clubId =
    club.id ||
    club.clubId ||
    metadata.id ||
    metadata.clubId ||
    listing.clubId ||
    listing.resourceId ||
    null;

  const clubName =
    club.name ||
    metadata.name ||
    listing.name ||
    listing.title ||
    "Unknown Club";

  const listPrice = Number(
    listing.price ??
    listing.listing?.price ??
    listing.listingPrice ??
    0
  );

  const divisionRaw =
    club.division ||
    metadata.division ||
    club.leagueDivision ||
    metadata.leagueDivision ||
    listing.division ||
    listing.club_division ||
    null;

  let visibleDivision = null;

  if (typeof divisionRaw === "number") {
    visibleDivision = DIVISION_NUMBER_MAP[divisionRaw] || null;
  } else if (typeof divisionRaw === "string") {
    visibleDivision =
      DIVISION_BASE_PRICE[divisionRaw] !== undefined
        ? divisionRaw
        : null;
  }

  return {
    id: String(listingId),
    clubId: clubId ? String(clubId) : null,
    clubName,
    listPrice,
    visibleDivision,
    raw: listing
  };
}

async function calculateClubValue({ clubId, visibleDivision, listPrice }) {
  const [{ leagueId, cupId }, contracts] = await Promise.all([
    fetchClubCompetitions(clubId),
    fetchContracts(clubId)
  ]);

  const [leagueComp, cupComp] = await Promise.all([
    fetchMflJson(`${API_BASE}/competitions/${leagueId}`),
    cupId ? fetchMflJson(`${API_BASE}/competitions/${cupId}`) : Promise.resolve(null)
  ]);

  const apiDivision = parseDivisionFromLeagueName(leagueComp.name);
  const division = apiDivision || visibleDivision;

  if (!division || DIVISION_BASE_PRICE[division] === undefined) {
    throw new Error(`Invalid division for club ${clubId}`);
  }

  const leagueReward = getLeagueReward(leagueComp, clubId);
  const cupReward = cupComp ? getCupReward(cupComp, clubId) : 0;
  const gross = roundUpToNearest005(leagueReward + cupReward);

  const deductionMultiplier = getContractDeductionMultiplier(contracts);
  const deductions = roundUpToNearest005(gross * deductionMultiplier);
  const net = roundUpToNearest005(gross - deductions);

  const rewardValue = net / CLUB_SETTINGS.mflToUsdDivisor;
  const divisionBase = DIVISION_BASE_PRICE[division];

  const fairPrice = divisionBase + rewardValue;
  const valueGap = listPrice !== null ? fairPrice - listPrice : 0;

  const exitAnalysis = calculateExitAnalysis({ division, listPrice });

  const decision = getInvestmentDecision({
    valueGap,
    listPrice,
    fairPrice,
    optimalExit: exitAnalysis.optimalExit
  });

  return {
    clubId,
    division,
    leagueReward,
    cupReward,
    gross,
    deductionMultiplier,
    deductions,
    net,
    rewardValue,
    divisionBase,
    fairPrice,
    valueGap,
    listPrice,
    exitAnalysis,
    decision
  };
}

async function alreadyAlertedClub(club) {
  const listingId = encodeURIComponent(club.id);
  const price = encodeURIComponent(club.listPrice);

  const data = await supabaseGet(
    `/rest/v1/mfl_alerted_club_listings?select=id&listing_id=eq.${listingId}&listed_price=eq.${price}&limit=1`
  );

  return Array.isArray(data) && data.length > 0;
}

async function saveClubAlert(club, result) {
  const optimal = result.exitAnalysis?.optimalExit || {};

  await supabasePost("/rest/v1/mfl_alerted_club_listings", {
    listing_id: club.id,
    club_id: club.clubId,
    club_name: club.clubName,
    listed_price: club.listPrice,
    division: result.division,
    grade: result.decision.grade,
    score: result.decision.score,
    fair_price: result.fairPrice,
    value_gap: result.valueGap,
    net_mfl: result.net,
    optimal_exit_division: optimal.exitDivision || null,
    roi_per_season: optimal.roiPerSeasonPercent || 0
  });
}

async function sendClubDiscord(club, result) {
  if (!DISCORD_WEBHOOK) return;

  const optimal = result.exitAnalysis?.optimalExit || {};

  const embed = {
    title: `🏟️ ${result.decision.grade}-Grade MFL Club Found`,
    url: "https://app.playmfl.com/marketplace/clubs",
    color: result.decision.grade === "A+" ? 0x00ff88 : 0x63ff5c,
    fields: [
      { name: "Club", value: club.clubName, inline: true },
      { name: "Listed Price", value: `$${club.listPrice}`, inline: true },
      { name: "Fair Price", value: `$${result.fairPrice.toFixed(2)}`, inline: true },
      { name: "Division", value: result.division, inline: true },
      { name: "Value Gap", value: `$${result.valueGap.toFixed(2)}`, inline: true },
      { name: "Net MFL", value: `${Math.round(result.net).toLocaleString()} MFL`, inline: true },
      { name: "Optimal Exit", value: optimal.exitDivision || "-", inline: true },
      {
        name: "ROI / Season",
        value: `${Number(optimal.roiPerSeasonPercent || 0).toFixed(1)}%`,
        inline: true
      },
      { name: "Score", value: `${result.decision.score}/100`, inline: true },
      { name: "Reason", value: result.decision.reason, inline: false }
    ],
    footer: {
      text: "MFL Club Market Scanner"
    },
    timestamp: new Date().toISOString()
  };

  await axios.post(
    DISCORD_WEBHOOK,
    {
      username: "MFL Club Scanner",
      embeds: [embed]
    },
    {
      timeout: 15000
    }
  );
}

async function scanClubMarketplace() {
  console.log(`[${new Date().toLocaleTimeString()}] Scanning MFL club marketplace...`);

  try {
    await cleanupOldClubAlerts();

    const res = await axios.get(CLUB_API, { timeout: 15000 });

    const listings = Array.isArray(res.data)
      ? res.data
      : res.data.listings || res.data.data || res.data.results || [];

    console.log(`Found ${listings.length} club listings`);

    for (const listing of listings) {
      const club = extractClubListing(listing);

      if (!club.id || seenClubListings.has(club.id)) continue;

      seenClubListings.add(club.id);

      if (!club.clubId || !club.listPrice) {
        console.log(`Skipping incomplete club listing: ${club.clubName}`);
        continue;
      }

      try {
        const result = await calculateClubValue({
          clubId: club.clubId,
          visibleDivision: club.visibleDivision,
          listPrice: club.listPrice
        });

        console.log(
          `${club.clubName} | ${result.division} | Listed $${club.listPrice} | Worth $${result.fairPrice.toFixed(2)} | ${result.decision.grade} | Score ${result.decision.score}`
        );

        if (CLUB_SETTINGS.alertGrades.includes(result.decision.grade)) {
          const seen = await alreadyAlertedClub(club);

          if (seen) {
            console.log(`Already alerted club, skipping Discord: ${club.clubName} @ $${club.listPrice}`);
          } else {
            await sendClubDiscord(club, result);
            await saveClubAlert(club, result);
            console.log(`🏟️ Club Discord alert sent and saved: ${club.clubName}`);
          }
        }
      } catch (err) {
        console.error(`Club valuation failed: ${club.clubName}`, err.message);
      }

      await sleep(250);
    }

    while (seenClubListings.size > 1000) {
      seenClubListings.delete(seenClubListings.values().next().value);
    }
  } catch (err) {
    console.error("Club scan error:", err.message);
  }
}

// =======================
// START
// =======================

async function startScanner() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  }

  console.log("======================================");
  console.log("MFL Market Scanner Started");
  console.log(`Scan interval: ${SCAN_INTERVAL}ms`);
  console.log(`Player min sales: ${RULES.minSales}`);
  console.log(`Player min profit: $${RULES.minProfit}`);
  console.log(`Player min ROI: ${RULES.minROI}%`);
  console.log("Player near-retirement filter: ENABLED");
  console.log("Club scanner: ENABLED");
  console.log(`Club alerts: ${CLUB_SETTINGS.alertGrades.join(", ")} only`);
  console.log("Deduplication: Supabase");
  console.log("======================================");

  await loadLiveDivisionPrices();

  await scanPlayerMarketplace();
  await scanClubMarketplace();

  setInterval(scanPlayerMarketplace, SCAN_INTERVAL);
  setInterval(scanClubMarketplace, SCAN_INTERVAL);
}
