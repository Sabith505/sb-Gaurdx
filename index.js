const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActivityType
} = require("discord.js");
const fs = require("fs");

const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID || "1478812501079490641";
const DEFAULT_CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 120000);
const AUTO_STATUS_INTERVAL_MS = 60 * 60 * 1000;
const DATA_FILE = "./bots.json";

if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN environment variable is missing.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function loadBots() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
}
function saveBots(bots) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(bots, null, 2));
}

let monitoredBots = loadBots();
for (const bot of monitoredBots) {
  if (!bot.intervalMs) bot.intervalMs = DEFAULT_CHECK_INTERVAL_MS;
}
let currentStatusMode = "online";
let autoStatusIndex = 0;
const autoStatuses = ["online", "idle", "dnd"];

const commands = [
  new SlashCommandBuilder()
    .setName("guardex")
    .setDescription("SB Guardex controls")
    .addSubcommand(s => s.setName("monitor-add").setDescription("Add a bot health/status URL")
      .addStringOption(o => o.setName("name").setDescription("Bot name").setRequired(true))
      .addStringOption(o => o.setName("url").setDescription("HTTP health/status URL").setRequired(true))
      .addIntegerOption(o => o.setName("interval").setDescription("Check interval in minutes").setMinValue(1).setMaxValue(1440).setRequired(false)))
    .addSubcommand(s => s.setName("monitor-remove").setDescription("Remove a monitored bot")
      .addStringOption(o => o.setName("name").setDescription("Bot name").setRequired(true)))
    .addSubcommand(s => s.setName("monitor-list").setDescription("List monitored bots"))
    .addSubcommand(s => s.setName("monitor-status").setDescription("Check all monitored bots now"))
    .addSubcommand(s => s.setName("monitor-check").setDescription("Check one monitored bot")
      .addStringOption(o => o.setName("name").setDescription("Bot name").setRequired(true)))
    .addSubcommand(s => s.setName("monitor-interval").setDescription("Change a bot's monitoring interval")
      .addStringOption(o => o.setName("name").setDescription("Bot name").setRequired(true))
      .addIntegerOption(o => o.setName("minutes").setDescription("Check interval in minutes").setMinValue(1).setMaxValue(1440).setRequired(true)))
    .addSubcommand(s => s.setName("change-status").setDescription("Change Guardex Discord status")
      .addStringOption(o => o.setName("status").setDescription("Choose a status").setRequired(true)
        .addChoices(
          { name: "Online", value: "online" },
          { name: "Idle", value: "idle" },
          { name: "DND", value: "dnd" },
          { name: "Invisible", value: "invisible" },
          { name: "Auto (1 hour)", value: "auto" }
        )))
    .addSubcommand(s => s.setName("credits").setDescription("Show SB Guardex credits"))
    .toJSON()
];

function ownerOnly(interaction) {
  return interaction.user.id === OWNER_ID;
}

function applyStatus(mode) {
  if (mode === "invisible") {
    client.user.setPresence({ status: "invisible", activities: [] });
    return;
  }

  const status = mode === "dnd" ? "dnd" : mode === "idle" ? "idle" : "online";
  client.user.setPresence({
    status,
    activities: [{
      name: "🛡️Gaurding Bots",
      type: ActivityType.Watching
    }]
  });
}

function startAutoStatus() {
  setInterval(() => {
    if (currentStatusMode !== "auto") return;
    const mode = autoStatuses[autoStatusIndex % autoStatuses.length];
    autoStatusIndex++;
    applyStatus(mode);
    console.log(`🔄 Auto status changed to ${mode}.`);
  }, AUTO_STATUS_INTERVAL_MS);
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  for (const guild of client.guilds.cache.values()) {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guild.id),
      { body: commands }
    );
  }
  console.log("✅ Guardex slash commands registered.");
}

async function checkBot(bot) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(bot.url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "SB-Guardex/1.0" }
    });
    const ms = Date.now() - started;
    return {
      online: response.ok,
      ms,
      code: response.status,
      error: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (err) {
    return {
      online: false,
      ms: Date.now() - started,
      code: null,
      error: err.name === "AbortError" ? "Timeout" : err.message
    };
  } finally {
    clearTimeout(timer);
  }
}

async function dmOwner(title, description, color) {
  try {
    const owner = await client.users.fetch(OWNER_ID);
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description)
      .setTimestamp()
      .setFooter({ text: "SB Guardex • Developed By SB Developers" });
    await owner.send({ embeds: [embed] });
  } catch (err) {
    console.error("❌ Could not DM owner:", err.message);
  }
}

async function checkAndNotify(bot) {
  const result = await checkBot(bot);
  const oldStatus = bot.online;

  bot.online = result.online;
  bot.lastCheck = new Date().toISOString();
  bot.latency = result.ms;
  bot.httpCode = result.code;
  bot.lastError = result.error;

  if (oldStatus !== undefined && oldStatus !== result.online) {
    if (result.online) {
      await dmOwner(`🟢 ${bot.name} Recovered`,
        `**${bot.name}** is back **ONLINE**.\n\n📡 Response: **${result.ms} ms**`,
        0x57F287);
    } else {
      await dmOwner(`🔴 ${bot.name} Offline`,
        `**${bot.name}** is **OFFLINE**.\n\n❌ Error: **${result.error || `HTTP ${result.code}`}**`,
        0xED4245);
    }
  }
  return result;
}

async function checkAll() {
  for (const bot of monitoredBots) await checkAndNotify(bot);
  saveBots(monitoredBots);
}

function scheduleBot(bot) {
  if (bot.timer) clearInterval(bot.timer);
  const intervalMs = Number(bot.intervalMs || DEFAULT_CHECK_INTERVAL_MS);
  bot.intervalMs = intervalMs;
  bot.timer = setInterval(async () => {
    await checkAndNotify(bot);
    saveBots(monitoredBots);
  }, intervalMs);
}

function scheduleAllBots() {
  for (const bot of monitoredBots) scheduleBot(bot);
}

client.once("ready", async () => {
  console.log(`🛡️ SB Guardex online as ${client.user.tag}`);
  console.log(`👁️ Monitoring ${monitoredBots.length} bot(s).`);
  applyStatus(currentStatusMode);
  startAutoStatus();
  await registerCommands();
  await checkAll();
  scheduleAllBots();
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "guardx") {
    if (!ownerOnly(interaction)) {
      return interaction.reply({
        content: "❌ Only the SB Guardex owner can use this command.",
        ephemeral: true
      });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "change-status") {
      const mode = interaction.options.getString("status", true);
      currentStatusMode = mode;

      if (mode === "auto") {
        autoStatusIndex = 0;
        applyStatus(autoStatuses[autoStatusIndex]);
        autoStatusIndex++;
      } else {
        applyStatus(mode);
      }

      const labels = {
        online: "🟢 Online",
        idle: "🌙 Idle",
        dnd: "⛔ DND",
        invisible: "🫥 Invisible",
        auto: "🔄 Auto — changes every 1 hour"
      };

      return interaction.reply({
        content: `✅ Guardex status changed to **${labels[mode]}**.`,
        ephemeral: true
      });
    }

    if (sub === "credits") {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x7C3AED)
            .setTitle("🛡️ SB Guardex")
            .setDescription(
              "### Developed By SB Developers\n\n" +
              "Multi-Bot Monitoring System\n\n" +
              "🛡️ Bot Monitoring • 📡 Health Checks • 🚨 Alerts"
            )
            .setFooter({ text: "SB Developers • SB Guardex" })
            .setTimestamp()
        ],
        ephemeral: false
      });
    }
  }

  if (interaction.commandName !== "guardex") return;

  if (!ownerOnly(interaction)) {
    return interaction.reply({
      content: "❌ Only the SB Guardex owner can use this command.",
      ephemeral: true
    });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "monitor-add") {
    const name = interaction.options.getString("name", true).trim();
    const url = interaction.options.getString("url", true).trim();
    const intervalMinutes = interaction.options.getInteger("interval") || Math.max(1, Math.round(DEFAULT_CHECK_INTERVAL_MS / 60000));

    if (!/^https?:\/\//i.test(url)) {
      return interaction.reply({
        content: "❌ URL must start with http:// or https://",
        ephemeral: true
      });
    }

    if (monitoredBots.some(b => b.name.toLowerCase() === name.toLowerCase())) {
      return interaction.reply({
        content: "❌ A bot with that name is already monitored.",
        ephemeral: true
      });
    }

    const bot = {
      name, url, online: undefined, lastCheck: null,
      latency: null, httpCode: null, lastError: null,
      intervalMs: intervalMinutes * 60 * 1000
    };

    monitoredBots.push(bot);
    saveBots(monitoredBots);
    const result = await checkAndNotify(bot);
    saveBots(monitoredBots);

    return interaction.reply({
      content: `${result.online ? "🟢" : "🔴"} **${name}** added to Guardex.\nStatus: **${result.online ? "ONLINE" : "OFFLINE"}**`,
      ephemeral: true
    });
  }

  if (sub === "monitor-remove") {
    const name = interaction.options.getString("name", true);
    const before = monitoredBots.length;
    monitoredBots = monitoredBots.filter(
      b => b.name.toLowerCase() !== name.toLowerCase()
    );

    if (monitoredBots.length === before) {
      return interaction.reply({
        content: "❌ Bot not found.",
        ephemeral: true
      });
    }

    saveBots(monitoredBots);
    return interaction.reply({
      content: `🗑️ **${name}** removed from Guardex.`,
      ephemeral: true
    });
  }

  if (sub === "monitor-interval") {
    const name = interaction.options.getString("name", true).trim();
    const minutes = interaction.options.getInteger("minutes", true);

    const bot = monitoredBots.find(b => b.name.toLowerCase() === name.toLowerCase());
    if (!bot) {
      return interaction.reply({ content: "❌ Bot not found.", ephemeral: true });
    }

    bot.intervalMs = minutes * 60 * 1000;
    scheduleBot(bot);
    saveBots(monitoredBots);

    return interaction.reply({
      content: `✅ **${bot.name}** monitoring interval changed to **${minutes} minute(s)**.`,
      ephemeral: true
    });
  }

  if (sub === "monitor-list") {
    if (!monitoredBots.length) {
      return interaction.reply({
        content: "📭 No bots are being monitored yet.",
        ephemeral: true
      });
    }

    const lines = monitoredBots.map(b =>
      `${b.online ? "🟢" : b.online === false ? "🔴" : "⚪"} **${b.name}** — ${
        b.online ? `${b.latency ?? "?"} ms` : b.lastError || "Not checked"
      } • ⏱️ ${Math.round((b.intervalMs || DEFAULT_CHECK_INTERVAL_MS) / 60000)} min`
    );

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x7C3AED)
          .setTitle("🛡️ SB Guardex")
          .setDescription(lines.join("\n"))
          .setFooter({ text: `${monitoredBots.length} bot(s) monitored` })
      ],
      ephemeral: true
    });
  }

  if (sub === "monitor-status") {
    await interaction.deferReply({ ephemeral: true });
    await checkAll();

    const lines = monitoredBots.map(b =>
      `${b.online ? "🟢" : "🔴"} **${b.name}** — ${
        b.online ? `ONLINE • ${b.latency} ms` :
        `OFFLINE • ${b.lastError || "Unknown error"}`
      }`
    );

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x7C3AED)
          .setTitle("📡 Guardex Status")
          .setDescription(lines.length ? lines.join("\n") : "No monitored bots.")
      ]
    });
  }

  if (sub === "monitor-check") {
    const name = interaction.options.getString("name", true);
    const bot = monitoredBots.find(
      b => b.name.toLowerCase() === name.toLowerCase()
    );

    if (!bot) {
      return interaction.reply({
        content: "❌ Bot not found.",
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });
    const result = await checkAndNotify(bot);
    saveBots(monitoredBots);

    return interaction.editReply(
      result.online
        ? `🟢 **${bot.name}** — ONLINE • ${result.ms} ms • HTTP ${result.code}`
        : `🔴 **${bot.name}** — OFFLINE • ${result.error}`
    );
  }
});

process.on("unhandledRejection", err => console.error("Unhandled rejection:", err));
process.on("uncaughtException", err => console.error("Uncaught exception:", err));

client.login(TOKEN);
