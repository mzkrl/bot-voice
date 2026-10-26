require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  PermissionsBitField,
  ChannelType,
  OverwriteType,
  ApplicationCommandOptionType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} = require("@discordjs/voice");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "!";
const STATE_FILE = path.join(__dirname, "state.json");
const READY_TIMEOUT_MS = 20000;
const REJOIN_DELAY_MS = 5000;
const UNKNOWN_GUILD = 10004;

if (!TOKEN) {
  console.error("DISCORD_TOKEN kosong di .env");
  process.exit(1);
}

const state = loadState();
const connections = new Map();
const rejoining = new Set();
const joinChains = new Map();

let client = null;

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [guildId, s] of Object.entries(parsed)) {
      if (s && typeof s.channelId === "string") {
        clean[guildId] = {
          channelId: s.channelId,
          joinedAt: Number.isFinite(s.joinedAt) ? s.joinedAt : Date.now(),
        };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function saveState() {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error("[state] gagal simpan state.json", e);
  }
}

function setTarget(guildId, channelId) {
  const prev = state[guildId];
  state[guildId] = {
    channelId,
    joinedAt: Number.isFinite(prev?.joinedAt) ? prev.joinedAt : Date.now(),
  };
  saveState();
}

function removeGuildState(guildId) {
  if (!(guildId in state)) return;
  delete state[guildId];
  saveState();
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h} jam ${m} menit ${s} detik`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeSend(send) {
  return async (t) => {
    try {
      await send(t);
    } catch (e) {
      console.log(`[reply] gagal kirim: ${e?.message ?? e}`);
    }
  };
}

function targetMatches(guildId, channelId) {
  return state[guildId] && state[guildId].channelId === channelId;
}

function isUnknownError(e, code) {
  if (!e) return false;
  if (e.code === code) return true;
  return e.status === 404 && /unknown/i.test(String(e.message ?? ""));
}

const FULL_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];
const SAFE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
];

const VOICE_CONNECT_ALLOW = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.Connect,
  PermissionsBitField.Flags.Speak,
  PermissionsBitField.Flags.SendMessages,
];
const TEXT_ALLOW = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.AttachFiles,
];

const PV_CATEGORY_NAME = "Fixed Private Generated";
const pvCategories = new Map();

async function getPvCategory(guild) {
  const cachedId = pvCategories.get(guild.id);
  if (cachedId) {
    const live = guild.channels.cache.get(cachedId);
    if (live && live.type === ChannelType.GuildCategory) return live;
    pvCategories.delete(guild.id);
  }
  let cat = guild.channels.cache.find(
    (chan) =>
      chan.type === ChannelType.GuildCategory &&
      chan.name.toLowerCase() === PV_CATEGORY_NAME.toLowerCase()
  );
  if (!cat) {
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
    ];
    if (client?.user?.id) {
      overwrites.push({
        id: client.user.id,
        type: OverwriteType.Member,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.ManageChannels,
        ],
      });
    }
    try {
      cat = await guild.channels.create({
        name: PV_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        permissionOverwrites: overwrites,
        reason: `kategori khusus channel private (${PV_CATEGORY_NAME})`,
      });
      console.log(`[pv:${guild.id}] kategori "${PV_CATEGORY_NAME}" kebikin ${cat.id}`);
    } catch (e) {
      console.error(`[pv:${guild.id}] gagal bikin kategori, fallback tanpa kategori`, e?.message ?? e);
      return null;
    }
  }
  pvCategories.set(guild.id, cat.id);
  return cat;
}

function parseMemberTags(text) {
  const ids = [];
  const re = /<@!?(\d+)>/g;
  let m;
  while ((m = re.exec(text ?? ""))) ids.push(m[1]);
  return [...new Set(ids)];
}

async function handleCreatePv(guild, creatorId, judulRaw, memberTags, tipe, reply) {
  const judul = String(judulRaw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 100);
  if (!judul) {
    await reply("Judulnya kosong woy.");
    return;
  }
  const isVoice = tipe === "voice";
  if (guild.channels.cache.size >= 500) {
    await reply("Server udah mentok batas 500 channel, masih gak bisa bikin.");
    return;
  }

  const tagText = String(memberTags ?? "");
  const rawIds = parseMemberTags(tagText);
  const noTag = tagText.replace(/<@!?\d+>/g, "").trim();
  if (noTag) {
    await reply("Param `member` harus format tag, contoh: @budi @ani. Teks gak dianggep.");
    return;
  }

  const memberIds = [];
  for (const id of rawIds) {
    try {
      await guild.members.fetch(id);
      memberIds.push(id);
    } catch {
      console.log(`[pv:${guild.id}] member ${id} gak ada di guild, skip`);
    }
  }
  const uniqueNames = [...new Set([creatorId, client?.user?.id, ...memberIds])].filter(Boolean);

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: isVoice
        ? [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]
        : [PermissionsBitField.Flags.ViewChannel],
    },
    ...uniqueNames.map((id) => ({
      id,
      type: OverwriteType.Member,
      allow: [...(isVoice ? VOICE_CONNECT_ALLOW : TEXT_ALLOW)],
    })),
  ];

  try {
    const category = await getPvCategory(guild);
    const channel = await guild.channels.create({
      name: judul,
      type: isVoice ? ChannelType.GuildVoice : ChannelType.GuildText,
      parent: category ? category.id : undefined,
      permissionOverwrites: overwrites,
      reason: `private ${isVoice ? "voice" : "chat"} ${judul}`,
    });
    await reply(
      `Private ${isVoice ? "voice" : "chat"} udah jadi: ${channel}` +
        (category ? `\nNonggonya di kategori **${category.name}**.` : "") +
        `\nYang bisa masuk: <@${creatorId}>${memberIds.length ? " plus " + memberIds.map((i) => `<@${i}>`).join(" ") : ""}\n` +
        `Hapusnya: \`/delpv\` nomor channel ini.`
    );
  } catch (e) {
    console.error(`[pv:${guild.id}] gagal bikin channel`, e);
    await reply(`Gagal bikin channel: ${e?.message ?? e}`);
  }
}

function canManagePv(member, channel) {
  if (member?.permissions?.has?.(PermissionsBitField.Flags.ManageChannels)) return true;
  const ow = channel?.permissionOverwrites?.cache?.get(member.id);
  return !!ow && ow.allow.has(PermissionsBitField.Flags.ViewChannel);
}

async function handleDelPv(guild, member, channel, reply) {
  if (!channel || typeof channel.isVoiceBased !== "function") {
    await reply("Perlu channel yang mau dihapus, contoh: `/delpv channel:#namanya`.");
    return;
  }
  try {
    if (!canManagePv(member, channel)) {
      await reply("Lu gak ada akses buat hapus ini channel.");
      return;
    }
    const nama = channel.name;
    const parentId = channel.parentId;
    await channel.delete(`delpv oleh ${member.id}`);

    let catNote = "";
    if (parentId) {
      const cat = guild.channels.cache.get(parentId);
      if (
        cat &&
        cat.type === ChannelType.GuildCategory &&
        cat.name.toLowerCase() === PV_CATEGORY_NAME.toLowerCase() &&
        cat.children.cache.size === 0
      ) {
        try {
          pvCategories.delete(guild.id);
          await cat.delete(`kosong, auto-cleanup ${member.id}`);
          catNote = " Kategorinya ikut dibersihin karena udah kosong.";
        } catch (e) {
          console.log(`[pv:${guild.id}] kategori gak bisa auto-dihapus`, e?.message ?? e);
        }
      }
    }
    await reply(`Private channel **${nama}** udah dihapus.${catNote}`);
  } catch (e) {
    console.error(`[pv:${guild.id}] gagal hapus`, e);
    await reply(`Gagal hapus channel: ${e?.message ?? e}`);
  }
}

const HELP_PAGES = {
  jam: {
    label: "Numpuk Jam",
    color: 0xf1c40f,
    title: "Numpuk Jam",
    description: "Bot didesain biar jam numpuknya gak reset — reconnect tanpa lepas channel, kena kick buat sendiri.",
    fields: [
      { name: "`/join` — `!join`", value: "Masukin bot ke VC yang ada lu. Stay sampai di-leave." },
      { name: "`/status`", value: "Cek durasi numpuk + status koneksi." },
      { name: "`/leave` — `!leave`", value: "Bot keluar, jam direset." },
    ],
  },
  pv: {
    label: "Private Room",
    color: 0x9b59b6,
    title: "Private room",
    description: "Room privat — cuma lu + yang di-tag bisa lihat & masuk. Nongol di kategori `Fixed Private Generated`.",
    fields: [
      {
        name: "`/pv judul:` `member:` `tipe:`",
        value: "`judul` wajib, `member` tag: `@budi @ani`, `tipe`: `chat` / `voice` (default `chat`).\nContoh: `/pv judul:Lobby @budi @ani voice`",
      },
      { name: "`!pv` — `!createprivate` / `!cp`", value: "Versi prefix. Contoh: `!pv Lobby @budi @ani voice`" },
      {
        name: "`/delpv channel:` — `!delpv`",
        value: "Hapus room. Yang boleh: pembuat, member di-tag, atau admin `Manage Channels`.",
      },
    ],
  },
};

function helpPageData(page) {
  if (page !== "semua" && HELP_PAGES[page]) return HELP_PAGES[page];
  return {
    color: 0x2ecc71,
    title: "Semua perintah",
    description: "Semua yang bisa bot ini. Pencet tombol di bawah buat fokus ke satu kategori.",
    fields: [
      ...HELP_PAGES.jam.fields,
      ...HELP_PAGES.pv.fields,
    ],
  };
}

function buildHelpPayload(page = "semua") {
  const data = helpPageData(page);
  const embed = new EmbedBuilder()
    .setColor(data.color)
    .setTitle(data.title)
    .setDescription(data.description)
    .setFooter({ text: "Tombol di bawah buat ganti halaman" });
  if (Array.isArray(data.fields) && data.fields.length) embed.addFields(data.fields);
  const avatar = client?.user?.displayAvatarURL?.();
  if (avatar) embed.setThumbnail(avatar);

  const row = new ActionRowBuilder().addComponents(
    ["jam", "pv", "semua"].map((key) => {
      const btn = new ButtonBuilder()
        .setCustomId(`help:${key}`)
        .setLabel(key === "semua" ? "Semua" : HELP_PAGES[key].label)
        .setStyle(key === page ? ButtonStyle.Primary : ButtonStyle.Secondary);
      return btn;
    })
  );
  return { embeds: [embed], components: [row] };
}

async function handleHelp(reply, page = "semua") {
  await reply(buildHelpPayload(page));
}

function getConn(guildId) {
  return connections.get(guildId) ?? null;
}

function destroyConnection(guildId) {
  const conn = connections.get(guildId);
  connections.delete(guildId);
  if (!conn) return;
  conn.removeAllListeners();
  try {
    conn.destroy();
  } catch {}
}

function connectionStatus(guildId) {
  return getConn(guildId)?.state?.status ?? null;
}

async function resolveVoiceChannel(guild, channelId) {
  let channel = guild.channels.cache.get(channelId) ?? null;
  if (!channel) {
    try {
      channel = await guild.channels.fetch(channelId);
    } catch (e) {
      console.log(`[voice:${guild.id}] channel ${channelId} belum kebaca`, e?.message ?? e);
      return null;
    }
  }
  return channel && channel.isVoiceBased() ? channel : null;
}

async function discordStillInChannel(guildId, channelId) {
  const guild = client?.guilds?.cache?.get(guildId);
  if (!guild) return null;
  let me = guild.members.me;
  if (!me) {
    try {
      me = await guild.members.fetchMe();
    } catch {
      return null;
    }
  }
  const current = me?.voice?.channelId ?? null;
  if (current === null) return false;
  return current === channelId ? true : "other";
}

function attachListeners(connection, guildId) {
  connection.on(VoiceConnectionStatus.Disconnected, (_, __, code) =>
    onDisconnected(guildId, code)
  );
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (connections.get(guildId) === connection) connections.delete(guildId);
  });
  connection.on("error", (e) => console.error(`[voice:${guildId}] connection error`, e));
}

async function freshJoin(guild, channel) {
  if (state[guild.id] && state[guild.id].channelId !== channel.id) {
    console.log(`[voice:${guild.id}] target udah berubah, batalkan join lama`);
    return false;
  }
  destroyConnection(guild.id);

  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
  } catch (e) {
    console.error(`[voice:${guild.id}] gagal join`, e);
    return false;
  }

  attachListeners(connection, guild.id);
  connections.set(guild.id, connection);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch (e) {
    console.error(`[voice:${guild.id}] gagal ready`, e?.message ?? e);
    if (connections.get(guild.id) === connection) destroyConnection(guild.id);
    return false;
  }

  if (!targetMatches(guild.id, channel.id)) {
    console.log(`[voice:${guild.id}] target keganti pas join, keluar lagi`);
    destroyConnection(guild.id);
    return false;
  }
  setTarget(guild.id, channel.id);
  console.log(`[voice:${guild.id}] join baru -> ${channel.name}`);
  return true;
}

async function ensureConnected(guild, channelId) {
  const channel = await resolveVoiceChannel(guild, channelId);
  if (!channel) {
    console.log(`[voice:${guild.id}] channel ${channelId} gak ada, stop`);
    if (targetMatches(guild.id, channelId)) removeGuildState(guild.id);
    destroyConnection(guild.id);
    return false;
  }
  if (state[guild.id] && state[guild.id].channelId !== channelId) {
    console.log(`[voice:${guild.id}] target udah berubah, skip join lama`);
    return false;
  }

  const former = getConn(guild.id);
  if (
    former &&
    (former.state.status === VoiceConnectionStatus.Connecting ||
      former.state.status === VoiceConnectionStatus.Signalling)
  ) {
    try {
      await entersState(former, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch {}
    if (!getConn(guild.id)) return freshJoin(guild, channel);
  }

  const actual = await discordStillInChannel(guild.id, channel.id);
  const conn = getConn(guild.id);

  if (actual === true && conn?.state.status === VoiceConnectionStatus.Ready) {
    if (targetMatches(guild.id, channel.id)) setTarget(guild.id, channel.id);
    return true;
  }

  if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) {
    const reason =
      actual === false
        ? "udah gak di channel menurut discord"
        : actual === "other"
          ? "dipindah ke channel laen"
          : "status koneksi gak ready";
    console.log(`[voice:${guild.id}] ${reason}, rejoin ke ${channel.name}`);
    try {
      conn.rejoin({ channelId: channel.id, selfDeaf: true, selfMute: false });
      await entersState(conn, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      if (!targetMatches(guild.id, channel.id)) {
        console.log(`[voice:${guild.id}] target keganti pas rejoin, keluar lagi`);
        destroyConnection(guild.id);
        return false;
      }
      setTarget(guild.id, channel.id);
      console.log(`[voice:${guild.id}] rejoin tanpa destroy -> ${channel.name}`);
      return true;
    } catch (e) {
      console.error(`[voice:${guild.id}] rejoin gagal, koneksi baru`, e?.message ?? e);
    }
  }

  return freshJoin(guild, channel);
}

function connectGuild(guild, channelId) {
  const prev = joinChains.get(guild.id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => ensureConnected(guild, channelId));
  joinChains.set(guild.id, next.catch(() => {}));
  return next;
}

function onDisconnected(guildId, code) {
  if (!state[guildId]) return;
  console.log(`[voice:${guildId}] terputus (code=${code ?? "?"}), cek status dulu...`);
  scheduleRejoin(guildId);
}

async function scheduleRejoin(guildId) {
  if (rejoining.has(guildId)) return;
  rejoining.add(guildId);
  try {
    while (state[guildId]) {
      const status = connectionStatus(guildId);
      if (status === VoiceConnectionStatus.Ready) return;

      const s = state[guildId];
      const guild = client?.guilds?.cache?.get(guildId);
      if (!guild) {
        await sleep(REJOIN_DELAY_MS);
        continue;
      }

      const inChannel = await discordStillInChannel(guildId, s.channelId);
      if (inChannel === true) {
        console.log(`[voice:${guildId}] discord masih anggap di channel, coba rejoin ringan`);
      } else if (inChannel === false) {
        console.log(`[voice:${guildId}] udah gak di channel, rejoin`);
      }

      if (await connectGuild(guild, s.channelId)) return;
      await sleep(REJOIN_DELAY_MS);
    }
  } finally {
    rejoining.delete(guildId);
  }
}

async function doJoin(guild, channel, reply) {
  if (!guild) {
    await reply("Command ini cuma bisa dipake di dalam server.");
    return;
  }
  if (!channel || !channel.isVoiceBased()) {
    await reply("Masuk voice channel dulu, baru jalanin command ini.");
    return;
  }
  setTarget(guild.id, channel.id);
  const ok = await connectGuild(guild, channel.id);
  if (ok) {
    await reply(`Masuk **${channel.name}**. Bot bakal stay, keluarin pake \`${PREFIX}leave\` atau \`/leave\`.`);
  } else {
    await reply(`Gagal masuk **${channel.name}**, auto rejoin bakal nyoba terus.`);
    scheduleRejoin(guild.id);
  }
}

async function doLeave(guild, reply) {
  if (!guild) {
    await reply("Command ini cuma bisa dipake di dalam server.");
    return;
  }
  const s = state[guild.id];
  removeGuildState(guild.id);
  destroyConnection(guild.id);
  if (s) {
    await reply(`Dikeluarin dengan baik. Durasi numpuk: **${formatDuration(Date.now() - s.joinedAt)}**`);
  } else {
    await reply("Gak ada sesi voice yang perlu dikeluarin.");
  }
}

async function doStatus(guild, reply) {
  if (!guild) {
    await reply("Command ini cuma bisa dipake di dalam server.");
    return;
  }
  const s = state[guild.id];
  if (!s) {
    await reply("Belum ada sesi voice. Jalanin `!join` atau `/join` dulu.");
    return;
  }
  const inVc = connectionStatus(guild.id) === VoiceConnectionStatus.Ready;
  await reply(
    `Status: **${inVc ? "stay di voice" : "reconnecting..."}**\n` +
      `Durasi: **${formatDuration(Date.now() - s.joinedAt)}**`
  );
}

const SLASH_COMMANDS = [
  {
    name: "join",
    description: "Masuk ke voice channel kamu dan stay",
  },
  {
    name: "leave",
    description: "Keluarin bot dari voice channel",
  },
  {
    name: "status",
    description: "Cek durasi bot numpuk di voice",
  },
  {
    name: "createprivate",
    description: "Bikin private chat/voice room buat lomba, cuman yang di-tag aja",
    options: [
      {
        name: "judul",
        description: "Nama channel",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: "member",
        description: "Tag member, contoh: @budi @ani (boleh kosong)",
        type: ApplicationCommandOptionType.String,
        required: false,
      },
      {
        name: "tipe",
        description: "Jenis room",
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: "chat", value: "chat" },
          { name: "voice", value: "voice" },
        ],
      },
    ],
  },
  {
    name: "pv",
    description: "Alias /createprivate — bikin private chat/voice room",
    options: [
      {
        name: "judul",
        description: "Nama channel",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: "member",
        description: "Tag member, contoh: @budi @ani (boleh kosong)",
        type: ApplicationCommandOptionType.String,
        required: false,
      },
      {
        name: "tipe",
        description: "Jenis room",
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: "chat", value: "chat" },
          { name: "voice", value: "voice" },
        ],
      },
    ],
  },
  {
    name: "delpv",
    description: "Hapus private channel yang gak dipake lagi",
    options: [
      {
        name: "channel",
        description: "Channel yang mau dihapus",
        type: ApplicationCommandOptionType.Channel,
        channel_types: [ChannelType.GuildText, ChannelType.GuildVoice],
        required: true,
      },
    ],
  },
  {
    name: "help",
    description: "Info semua perintah bot",
  },
];

async function restoreTargets(c) {
  for (const guildId of Object.keys(state)) {
    let guild = c.guilds.cache.get(guildId) ?? null;
    if (!guild) {
      try {
        guild = await c.guilds.fetch(guildId);
      } catch (e) {
        if (isUnknownError(e, UNKNOWN_GUILD)) {
          console.log(`[state] guild ${guildId} gak ada, buang dari state`);
          removeGuildState(guildId);
          continue;
        }
        console.log(`[state] guild ${guildId} belum kebaca, coba lagi nanti`);
        scheduleRejoin(guildId);
        continue;
      }
    }
    if (!(await connectGuild(guild, state[guildId].channelId))) scheduleRejoin(guildId);
  }
  saveState();
}

function createClient(intents) {
  const c = new Client({ intents });
  client = c;

  c.on("error", (e) => console.error("client error", e));

  c.once("clientReady", async () => {
    console.log(`Logged in sebagai ${c.user.tag} (prefix: ${intents === SAFE_INTENTS ? "OFF, slash-only" : "ON"})`);
    c.user.setActivity("/help buat info • numpuk jam di voice");

    try {
      await new REST()
        .setToken(TOKEN)
        .put(Routes.applicationCommands(c.application.id), { body: SLASH_COMMANDS });
      console.log("Slash commands terdaftar");
    } catch (e) {
      console.error("Gagal daftar slash commands", e);
    }

    await restoreTargets(c);
  });

  c.on("guildDelete", (guild) => {
    removeGuildState(guild.id);
    destroyConnection(guild.id);
  });

  c.on("messageCreate", async (msg) => {
    if (msg.author.bot || !msg.inGuild() || !msg.member) return;
    if (!msg.content.startsWith(PREFIX)) return;
    const rest = msg.content.slice(PREFIX.length).trim();
    if (!rest) return;
    const name = (rest.split(/\s+/)[0] || "").toLowerCase();
    const raw = rest.slice(name.length).trim();
    const reply = safeSend((t) => msg.reply(t));

    if (name === "join") await doJoin(msg.guild, msg.member.voice?.channel, reply);
    else if (name === "leave") await doLeave(msg.guild, reply);
    else if (name === "status") await doStatus(msg.guild, reply);
    else if (name === "help") await handleHelp(reply);
    else if (name === "pv" || name === "createprivate" || name === "cp") {
      const { judul, memberIds, tipe } = parsePvArgs(raw);
      await handleCreatePv(msg.guild, msg.author.id, judul, memberIds.map((i) => `<@${i}>`).join(" "), tipe, reply);
    } else if (name === "delpv") {
      const m = /<#(\d+)>/g.exec(raw);
      const id = m?.[1] ?? /^\d+$/.exec(raw)?.[0];
      const channel = id ? msg.guild.channels.cache.get(id) : null;
      await handleDelPv(msg.guild, msg.member, channel, reply);
    }
  });

  c.on("interactionCreate", async (interaction) => {
    if (interaction.isButton() && interaction.customId?.startsWith("help:")) {
      const raw = interaction.customId.slice("help:".length);
      const page = HELP_PAGES[raw] ? raw : "semua";
      try {
        await interaction.update(buildHelpPayload(page));
      } catch (e) {
        console.log(`[help] gagal ganti halaman: ${e?.message ?? e}`);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    const slow = ["join", "createprivate", "pv", "delpv"].includes(interaction.commandName);
    let send;
    if (slow) {
      try {
        await interaction.deferReply();
      } catch (e) {
        console.error("[reply] defer gagal", e);
        return;
      }
      send = (t) => interaction.editReply(t);
    } else {
      send = (t) => interaction.reply(t);
    }
    const reply = safeSend(send);

    if (interaction.commandName === "join") {
      await doJoin(interaction.guild, interaction.member?.voice?.channel, reply);
    } else if (interaction.commandName === "leave") {
      await doLeave(interaction.guild, reply);
    } else if (interaction.commandName === "status") {
      await doStatus(interaction.guild, reply);
    } else if (interaction.commandName === "help") {
      await handleHelp(reply);
    } else if (interaction.commandName === "createprivate" || interaction.commandName === "pv") {
      if (!interaction.guild) {
        await reply("Command ini cuma bisa dipake di dalam server.");
        return;
      }
      await handleCreatePv(
        interaction.guild,
        interaction.user.id,
        interaction.options.getString("judul"),
        interaction.options.getString("member", false) ?? "",
        interaction.options.getString("tipe", false) ?? "chat",
        reply
      );
    } else if (interaction.commandName === "delpv") {
      if (!interaction.guild) {
        await reply("Command ini cuma bisa dipake di dalam server.");
        return;
      }
      await handleDelPv(
        interaction.guild,
        interaction.member,
        interaction.options.getChannel("channel", false),
        reply
      );
    }
  });

  c.on("voiceStateUpdate", (oldState, newState) => {
    const member = newState.member ?? oldState.member;
    if (!member || member.id !== c.user.id) return;
    const guildId = member.guild.id;
    const s = state[guildId];
    if (!s) return;
    if (newState.channelId && newState.channelId !== s.channelId) {
      console.log(`[voice:${guildId}] bot dipindah, balikin ke target`);
      connectGuild(member.guild, s.channelId).then((ok) => {
        if (!ok) scheduleRejoin(guildId);
      });
    }
  });

  return c;
}

function parsePvArgs(raw) {
  let text = raw;
  let tipe = "chat";
  const mTipe = /\b(chat|voice)\s*$/i.exec(text);
  if (mTipe) {
    tipe = mTipe[1].toLowerCase();
    text = text.slice(0, mTipe.index);
  }
  const memberIds = parseMemberTags(text);
  const judul = text.replace(/<@!?\d+>/g, "").trim().replace(/\s+/g, " ");
  return { judul, memberIds, tipe };
}

function start(intents) {
  const c = createClient(intents);
  c.login(TOKEN).catch((e) => {
    const msg = String(e?.message ?? e);
    const intentError = /disallowed intents|invalid intents|Used disallowed/i.test(msg);
    if (intentError && intents === FULL_INTENTS) {
      console.warn("Message Content Intent belum aktif di Developer Portal.");
      console.warn("Fallback ke slash-only (/join, /leave, /status). Nyalain intent di portal terus restart biar prefix ! hidup.");
      try {
        c.destroy();
      } catch {}
      start(SAFE_INTENTS);
      return;
    }
    console.error("Login gagal", e);
    process.exit(1);
  });
}

function shutdown(signal) {
  console.log(`[shutdown] ${signal}, simpan state & putus voice`);
  saveState();
  for (const guildId of [...connections.keys()]) destroyConnection(guildId);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

start(FULL_INTENTS);
