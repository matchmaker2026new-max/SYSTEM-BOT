const fs = require('node:fs');
const path = require('node:path');
const {
  Client, GatewayIntentBits, Partials, PermissionFlagsBits,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes
} = require('discord.js');
const { token, clientId, guildId, prefix, ownerId } = require('./config');
const store = require('./store');

const instanceLockPath = path.join(__dirname, '..', '.bot.lock');
const messageClaimDir = path.join(__dirname, '..', '.message-claims');
const interactionClaimDir = path.join(__dirname, '..', '.interaction-claims');
function ensureSingleInstance() {
  try {
    if (fs.existsSync(instanceLockPath)) {
      const prevPid = Number(String(fs.readFileSync(instanceLockPath, 'utf8')).trim());
      if (Number.isInteger(prevPid) && prevPid > 0) {
        try {
          process.kill(prevPid, 0);
          console.error('⚠️ البوت يعمل بالفعل. لا تشغل أكثر من نسخة واحدة.');
          process.exit(1);
        } catch {
          fs.unlinkSync(instanceLockPath);
        }
      } else {
        fs.unlinkSync(instanceLockPath);
      }
    }
    fs.writeFileSync(instanceLockPath, String(process.pid), 'utf8');
  } catch (error) {
    console.error('⚠️ تعذر إنشاء قفل التشغيل:', error.message);
    process.exit(1);
  }
}
ensureSingleInstance();
process.on('exit', () => {
  try {
    const currentPid = String(fs.readFileSync(instanceLockPath, 'utf8')).trim();
    if (currentPid === String(process.pid)) fs.unlinkSync(instanceLockPath);
  } catch (_) {}
});

if (!token || !clientId) throw new Error('ضع DISCORD_TOKEN و CLIENT_ID في ملف .env');
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});
const COLOR = 0x5865f2;
const EMOJIS = { ok: '✦', error: '✧', mod: '🛡️', time: '⏱️', trash: '🧹', ban: '🔨', kick: '👢', lock: '🔒', unlock: '🔓', gift: '🎁', bell: '🔔', info: '💠' };
const TAX_CHANNEL_ID = '1545360870488539287';
const FEEDBACK_CHANNEL_ID = '1520221295944400957';
const LINE_IMAGE_URL = 'https://cdn.phototourl.com/free/2026-09-09-10fc198a-e35a-4e25-a8d0-4b2e12389c8f.png';
const TAX_RATE = 0.05;
const processedMessageIds = new Map();
const processedInteractionIds = new Set();
const activeGames = new Map();
const movieQuestions = [
  { emojis: '🧊🚢💔', answer: 'Titanic', options: ['Titanic', 'Avatar', 'Joker', 'Frozen'] },
  { emojis: '🦁👑🌅', answer: 'The Lion King', options: ['The Lion King', 'The Matrix', 'Gladiator', 'Aladdin'] },
  { emojis: '🧙‍♂️💍🌋', answer: 'The Lord of the Rings', options: ['Harry Potter', 'The Lord of the Rings', 'The Hobbit', 'Star Wars'] },
  { emojis: '🦈🌊🚤', answer: 'Jaws', options: ['Jaws', 'Finding Nemo', 'Jurassic Park', 'Aquaman'] },
  { emojis: '🕷️🧑🏙️', answer: 'Spider-Man', options: ['Batman', 'Spider-Man', 'Superman', 'Iron Man'] }
];
const speedWords = ['نجمة', 'مغامرة', 'بطولة', 'سرعة', 'مفاجأة', 'تحدي', 'أسطورة', 'فوز'];
function claimMessage(messageId) {
  fs.mkdirSync(messageClaimDir, { recursive: true });
  const claimPath = path.join(messageClaimDir, `${messageId}.lock`);
  try {
    const handle = fs.openSync(claimPath, 'wx');
    fs.closeSync(handle);
    setTimeout(() => fs.rmSync(claimPath, { force: true }), 120000);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') return true;
    try {
      if (Date.now() - fs.statSync(claimPath).mtimeMs > 120000) {
        fs.rmSync(claimPath, { force: true });
        return claimMessage(messageId);
      }
    } catch (_) {}
    return false;
  }
}
function claimInteraction(interactionId) {
  fs.mkdirSync(interactionClaimDir, { recursive: true });
  const claimPath = path.join(interactionClaimDir, `${interactionId}.lock`);
  try {
    const handle = fs.openSync(claimPath, 'wx');
    fs.closeSync(handle);
    setTimeout(() => fs.rmSync(claimPath, { force: true }), 120000);
    return true;
  } catch (error) {
    return error.code === 'EEXIST' ? false : true;
  }
}
async function feedbackAlreadyHandled(message) {
  const recent = await message.channel.messages.fetch({ limit: 50 }).catch(() => null);
  return recent?.some(item => item.author.id === client.user.id && item.reference?.messageId === message.id) || false;
}
async function removeDuplicateFeedbackReplies(message) {
  const recent = await message.channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return;
  const replies = [...recent.values()]
    .filter(item => item.author.id === client.user.id && item.reference?.messageId === message.id)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const embeds = replies.filter(item => item.embeds.length > 0);
  const images = replies.filter(item => item.embeds.length === 0 && item.attachments.size > 0);
  for (const duplicate of [...embeds.slice(1), ...images.slice(1)]) {
    await duplicate.delete().catch(() => {});
  }
}
async function sendFeedbackMessage(channel, payload, messageId) {
  try {
    return await channel.send({ ...payload, reply: { messageReference: messageId, failIfNotExists: false } });
  } catch (error) {
    if (error.code !== 50035) throw error;
    return channel.send(payload);
  }
}

const MOD_ROLE_ID = '1546616567016722463';
const modCommands = new Set(['clear', 'ban', 'unban', 'kick', 'timeout', 'untimeout', 'mute', 'warn', 'lock', 'unlock', 'hide', 'add-user', 'remove-user', 'delete', 'autoreply-add', 'autoreply-remove', 'line-mode', 'logs-info', 'nickname', 'protection-status', 'remove-all-tokens', 'remove-autoline-channel', 'remove-nadeko-room', 'remove-token', 'rename', 'role', 'send', 'send-broadcast-panel', 'set-autoline-line', 'set-feedback-line', 'set-feedback-room', 'set-message', 'set-project-logs', 'set-shortcut', 'set-suggestions-line', 'set-suggestions-room', 'set-tax-line', 'set-tax-room', 'setup-logs', 'setup-rating', 'setup-welcome', 'suggestion-mode', 'tax', 'come']);
const defs = [
  ['add-autoline-channel', 'تحديد قناة الخط التلقائي', [{ name: 'channel', description: 'القناة', type: 7, required: true }]],
  ['add-button', 'إرسال زر تفاعلي', [{ name: 'text', description: 'نص الزر', type: 3, required: true }]],
  ['add-info-button', 'إرسال زر معلومات', [{ name: 'text', description: 'المعلومات التي تظهر عند الضغط', type: 3, required: true }]],
  ['add-nadeko-room', 'تحديد غرفة Nadeko', [{ name: 'channel', description: 'القناة', type: 7, required: true }]],
  ['add-ticket-button', 'إرسال زر تذكرة', [{ name: 'text', description: 'نص الزر', type: 3, required: false }]],
  ['clear', 'مسح عدد من الرسائل', [{ name: 'amount', description: 'عدد الرسائل من 1 إلى 100', type: 4, required: false }]],
  ['ban', 'حظر عضو من السيرفر', [{ name: 'user', description: 'العضو المطلوب حظره', type: 6, required: true }, { name: 'reason', description: 'سبب الحظر', type: 3, required: false }]],
  ['unban', 'إزالة الحظر عن مستخدم', [{ name: 'user', description: 'معرف المستخدم', type: 3, required: true }]],
  ['kick', 'طرد عضو من السيرفر', [{ name: 'user', description: 'العضو المطلوب طرده', type: 6, required: true }, { name: 'reason', description: 'سبب الطرد', type: 3, required: false }]],
  ['warn', 'تحذير عضو', [{ name: 'user', description: 'العضو المطلوب تحذيره', type: 6, required: true }]],
  ['timeout', 'كتم عضو لمدة بالدقائق', [{ name: 'user', description: 'العضو المطلوب كتمه', type: 6, required: true }, { name: 'minutes', description: 'المدة بالدقائق', type: 4, required: false }]],
  ['untimeout', 'إزالة الكتم عن عضو', [{ name: 'user', description: 'العضو', type: 6, required: true }]],
  ['anti-ban', 'تفعيل أو تعطيل حماية الحظر', [{ name: 'enabled', description: 'تشغيل أو إيقاف', type: 5, required: true }]],
  ['anti-bots', 'تفعيل أو تعطيل حماية البوتات', [{ name: 'enabled', description: 'تشغيل أو إيقاف', type: 5, required: true }]],
  ['anti-delete-roles', 'حماية الرتب من الحذف', [{ name: 'enabled', description: 'تشغيل أو إيقاف', type: 5, required: true }]],
  ['anti-delete-rooms', 'حماية القنوات من الحذف', [{ name: 'enabled', description: 'تشغيل أو إيقاف', type: 5, required: true }]],
  ['autoreply-add', 'إضافة رد تلقائي', [{ name: 'trigger', description: 'الكلمة', type: 3, required: true }, { name: 'reply', description: 'الرد', type: 3, required: true }]],
  ['autoreply-list', 'عرض الردود التلقائية', []],
  ['autoreply-remove', 'حذف رد تلقائي', [{ name: 'trigger', description: 'الكلمة', type: 3, required: true }]],
  ['avatar', 'عرض صورة عضو', [{ name: 'user', description: 'العضو', type: 6, required: false }]],
  ['banner', 'عرض بانر عضو', [{ name: 'user', description: 'العضو', type: 6, required: false }]],
  ['close', 'قفل القناة الحالية', []],
  ['close-apply', 'قفل قناة التقديم', []],
  ['copy-emoji', 'نسخ رابط إيموجي', [{ name: 'emoji', description: 'الإيموجي أو منشن الإيموجي', type: 3, required: true }]],
  ['delete', 'حذف رسالة الأمر', []],
  ['dm-mode', 'تفعيل أو تعطيل وضع الخاص', [{ name: 'enabled', description: 'تشغيل أو إيقاف', type: 5, required: true }]],
  ['feedback-mode', 'تفعيل أو تعطيل وضع التقييم', [{ name: 'enabled', description: 'تشغيل أو إيقاف', type: 5, required: true }]],
  ['gend', 'بدء سحب مختصر', [{ name: 'seconds', description: 'المدة بالثواني', type: 4, required: true }, { name: 'prize', description: 'الجائزة', type: 3, required: true }]],
  ['greroll', 'إعادة اختيار فائز السحب', [{ name: 'message', description: 'معرف رسالة السحب', type: 3, required: true }]],
  ['gstart', 'بدء سحب تفاعلي', [{ name: 'seconds', description: 'المدة بالثواني', type: 4, required: true }, { name: 'prize', description: 'الجائزة', type: 3, required: true }]],
  ['games', 'عرض ألعاب الفعاليات', []],
  ['movie', 'خمن الفيلم من الإيموجي', []],
  ['speed', 'لعبة أسرع شخص', []],
  ['lucky', 'لعبة الرقم المحظوظ', []],
  ['lock', 'قفل القناة الحالية', []], ['unlock', 'فتح القناة الحالية', []], ['hide', 'إخفاء القناة عن الأعضاء', []],
  ['add-user', 'إضافة عضو إلى القناة', [{ name: 'user', description: 'العضو', type: 6, required: true }]],
  ['remove-user', 'إزالة عضو من القناة', [{ name: 'user', description: 'العضو', type: 6, required: true }]],
  ['serverinfo', 'عرض معلومات السيرفر', []], ['userinfo', 'عرض معلومات عضو', [{ name: 'user', description: 'العضو', type: 6, required: false }]],
  ['say', 'إرسال رسالة باسم البوت', [{ name: 'text', description: 'نص الرسالة', type: 3, required: true }]],
  ['send', 'إرسال رسالة في القناة', [{ name: 'text', description: 'نص الرسالة', type: 3, required: true }]],
  ['embed', 'إرسال رسالة Embed', [{ name: 'text', description: 'نص الرسالة', type: 3, required: true }, { name: 'color', description: 'لون Hex مثل #ff0000 أو اسم لون', type: 3, required: false }]],
  ['come', 'استدعاء عضو في الخاص', [{ name: 'user', description: 'العضو', type: 6, required: true }]],
  ['nickname', 'تغيير لقب عضو', [{ name: 'user', description: 'العضو', type: 6, required: true }, { name: 'name', description: 'اللقب الجديد', type: 3, required: false }]],
  ['ping', 'فحص سرعة استجابة البوت', []],
  ['protection-status', 'عرض حالة الحماية', []],
  ['logs-info', 'عرض حالة سجل الإدارة', []],
  ['line-mode', 'تفعيل أو تعطيل خط الرسائل', [{ name: 'enabled', description: 'تشغيل أو إيقاف', type: 5, required: true }]],
  ['send-broadcast-panel', 'إرسال لوحة بث تفاعلية', []],
  ['set-autoline-line', 'تحديد رسالة الخط التلقائي', [{ name: 'text', description: 'نص الخط', type: 3, required: true }]],
  ['set-feedback-line', 'تحديد رسالة خط التقييم', [{ name: 'text', description: 'نص الخط', type: 3, required: true }]],
  ['set-feedback-room', 'تحديد قناة التقييم', [{ name: 'channel', description: 'القناة', type: 7, required: true }]],
  ['set-message', 'تحديد رسالة تلقائية للقناة', [{ name: 'text', description: 'الرسالة', type: 3, required: true }]],
  ['set-project-logs', 'تحديد قناة سجلات المشروع', [{ name: 'channel', description: 'القناة', type: 7, required: true }]],
  ['set-shortcut', 'حفظ اختصار لأمر', [{ name: 'shortcut', description: 'الاختصار', type: 3, required: true }, { name: 'command', description: 'الأمر', type: 3, required: true }]],
  ['set-suggestions-line', 'تحديد خط الاقتراحات', [{ name: 'text', description: 'نص الخط', type: 3, required: true }]],
  ['set-suggestions-room', 'تحديد قناة الاقتراحات', [{ name: 'channel', description: 'القناة', type: 7, required: true }]],
  ['set-tax-line', 'تحديد خط الضرائب', [{ name: 'text', description: 'نص الخط', type: 3, required: true }]],
  ['set-tax-room', 'تحديد قناة الضرائب', [{ name: 'channel', description: 'القناة', type: 7, required: true }]],
  ['setup-logs', 'إعداد نظام السجلات', []],
  ['setup-rating', 'إعداد نظام التقييم', []],
  ['setup-welcome', 'إعداد الترحيب', []],
  ['mute', 'كتم عضو', [{ name: 'user', description: 'العضو', type: 6, required: true }, { name: 'minutes', description: 'المدة بالدقائق', type: 4, required: false }]],
  ['new-apply', 'إرسال لوحة تقديم', []],
  ['new-panel', 'إرسال لوحة تفاعلية', []],
  ['remove-all-tokens', 'حذف كل التوكنات المحفوظة', []],
  ['remove-autoline-channel', 'إزالة قناة الخط التلقائي', []],
  ['remove-nadeko-room', 'إزالة غرفة Nadeko', []],
  ['remove-token', 'حذف توكن محفوظ', [{ name: 'token', description: 'اسم التوكن', type: 3, required: true }]],
  ['role', 'إضافة أو إزالة رتبة من عضو', [{ name: 'user', description: 'العضو', type: 6, required: true }, { name: 'role', description: 'الرتبة', type: 8, required: true }, { name: 'action', description: 'add أو remove', type: 3, required: false }]],
  ['roles', 'عرض رتب السيرفر', []],
  ['rename', 'تغيير اسم القناة', [{ name: 'name', description: 'الاسم الجديد', type: 3, required: true }]],
  ['server', 'اختصار معلومات السيرفر', []],
  ['suggestion-mode', 'تفعيل وضع الاقتراحات', []],
  ['tax', 'حساب المبلغ بعد ضريبة 5%', [{ name: 'amount', description: 'المبلغ الصافي مثل 10m أو 500k', type: 3, required: true }]],
  ['help', 'عرض قائمة الأوامر', []]
];
const slashCommands = defs.map(([name, description, options]) => ({ name, description, options, default_member_permissions: modCommands.has(name) ? String(PermissionFlagsBits.ManageMessages) : undefined }));
const aliases = {
  'م': 'clear', 'مسح': 'clear',
  'كسرة': 'ban', 'ب': 'ban', 'باند': 'ban', 'بان': 'ban',
  'ان باند': 'unban', 'ان-باند': 'unban', 'فك-الباند': 'unban', 'unban': 'unban',
  'ط': 'kick', 'طرد': 'kick', 'برا': 'kick',
  'اص': 'timeout', 'ك': 'timeout', 'كتم': 'timeout', 'تايم': 'timeout',
  'ان تايم': 'untimeout', 'ان-تايم': 'untimeout', 'فك': 'untimeout',
  'ق': 'lock', 'قفل': 'lock', 'فتح': 'unlock',
  'اخفاء': 'hide', 'إخفاء': 'hide',
  'اضافة': 'add-user', 'إضافة': 'add-user',
  'حذف-عضو': 'remove-user', 'احذف': 'delete',
  'صورة': 'avatar', 'افتار': 'avatar', 'بانر': 'banner',
  'معلومات': 'serverinfo', 'سيرفر': 'serverinfo', 'عضو': 'userinfo',
  'قول': 'say', 'ارسال': 'send', 'إرسال': 'send', 'امبد': 'embed',
  'لقب': 'nickname', 'اسم': 'rename', 'رتبة': 'role', 'الرتب': 'roles',
  'بنق': 'ping', 'حالة-الحماية': 'protection-status',
  'العاب': 'games', 'ألعاب': 'games', 'فيلم': 'movie', 'سرعة': 'speed', 'محظوظ': 'lucky',
  'خط': 'line-mode', 'line': 'line-mode', 'اقتراحات': 'suggestion-mode', 'ضريبة': 'tax',
  'حذف-التوكنات': 'remove-all-tokens', 'حذف-توكن': 'remove-token', 'حذف-خط': 'remove-autoline-channel',
  'تعال': 'come', 'رد': 'autoreply-add', 'ردود': 'autoreply-list', 'حذف-رد': 'autoreply-remove', 'تحذير': 'warn',
  'سحب': 'gstart', 'مساعدة': 'help', 'تحذير': 'warn'
};

function isMod(member) {
  if (!member) return false;
  return member.permissions?.has(PermissionFlagsBits.ManageGuild)
    || member.permissions?.has(PermissionFlagsBits.ManageMessages)
    || member.roles?.cache?.has(MOD_ROLE_ID)
    || member.id === ownerId;
}
function key(guildId, name) { return `${guildId}:${name}`; }
function reply(ctx, payload) {
  if (ctx.isChatInputCommand?.()) {
    return ctx.reply(payload);
  }
  const message = typeof payload === 'string'
    ? { embeds: [card('✅ تم التنفيذ', payload, 0x57f287)], allowedMentions: { parse: [], repliedUser: false } }
    : payload;
  const sent = ctx.reply(message);
  return sent;
}
function temporaryReply(ctx, payload) {
  if (ctx.isChatInputCommand?.()) {
    return ctx.reply(payload).then(() => {
      setTimeout(() => ctx.deleteReply().catch(() => {}), 5000);
    });
  }
  const message = typeof payload === 'string'
    ? { embeds: [card('✅ تم التنفيذ', payload, 0x57f287)], allowedMentions: { parse: [], repliedUser: false } }
    : payload;
  const sent = ctx.reply(message);
  setTimeout(() => sent.then(m => m.delete().catch(() => {})).catch(() => {}), 5000);
  return sent;
}
function guildOf(ctx) { return ctx.guild; }
function memberOf(ctx) { return ctx.isChatInputCommand?.() ? (ctx.options.getMember('user') || ctx.guild?.members.cache.get(ctx.options.getUser('user')?.id)) : ctx.mentions.members.first(); }
function userOf(ctx) { return ctx.isChatInputCommand?.() ? (ctx.options.getUser('user') || ctx.user) : (ctx.mentions.users.first() || ctx.author); }
function textOf(ctx, args, name) {
  if (ctx.isChatInputCommand?.()) return ctx.options.getString(name) || '';
  if (!Array.isArray(args)) return '';
  return args.join(' ').trim();
}
function numberOf(ctx, args, name, fallback) { return ctx.isChatInputCommand?.() ? (ctx.options.getInteger(name) || fallback) : (Number(args[0]) || fallback); }
function parseCommand(rawContent) {
  const content = String(rawContent || '').trim();
  if (!content) return null;
  const isPrefixed = content.startsWith(prefix);
  const candidate = (isPrefixed ? content.slice(prefix.length) : content).trim();
  if (!candidate) return null;
  const parts = candidate.split(/\s+/);
  let raw = parts.shift()?.toLowerCase();
  const twoWordAlias = `${raw || ''} ${(parts[0] || '').toLowerCase()}`.trim();
  if (aliases[twoWordAlias]) {
    raw = twoWordAlias;
    parts.shift();
  }
  const name = aliases[raw] || raw;
  if (!name || !defs.some(([command]) => command === name)) return null;
  return { name, args: parts };
}
function parseCreditAmount(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[,\s]/g, '');
  const match = normalized.match(/^(\d+(?:\.\d+)?)(k|m|b)?$/);
  if (!match) return null;
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[match[2] || ''] || 1;
  const amount = Number(match[1]) * multiplier;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
const embedColors = {
  red: 0xed4245, green: 0x57f287, blue: 0x3498db, yellow: 0xfee75c,
  orange: 0xe67e22, purple: 0x9b59b6, pink: 0xeb459e, black: 0x000000,
  white: 0xffffff, cyan: 0x00ffff, gold: 0xffd700, gray: 0x95a5a6,
  احمر: 0xed4245, اخضر: 0x57f287, ازرق: 0x3498db, اصفر: 0xfee75c,
  برتقالي: 0xe67e22, بنفسجي: 0x9b59b6, وردي: 0xeb459e, ابيض: 0xffffff,
  اسود: 0x000000
};
function parseEmbedColor(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) return COLOR;
  if (embedColors[input] !== undefined) return embedColors[input];
  const hex = input.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) return Number.parseInt(hex, 16);
  if (/^[0-9a-f]{3}$/i.test(hex)) return Number.parseInt(hex.split('').map(char => char + char).join(''), 16);
  return null;
}
function gameId() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; }
function gameButtons(type, id, labels, disabled = false) {
  return new ActionRowBuilder().addComponents(labels.map((label, index) => new ButtonBuilder()
    .setCustomId(`game:${type}:${id}:${index}`)
    .setLabel(label.slice(0, 80))
    .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(disabled)));
}
function gameWinnerEmbed(title, user, details) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`🏆 ${title}`)
    .setDescription(`الفائز هو ${user}\n\n${details}`)
    .setFooter({ text: 'نظام الألعاب • فائز واحد لكل جولة' })
    .setTimestamp();
}
function mention(member) { return member?.toString?.() || `<@${member?.id}>`; }
function arabicNumber(value) { return Number(value).toLocaleString('ar-EG'); }
function prettyDuration(ms) {
  const total = Math.max(1, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60), seconds = total % 60;
  if (minutes) return `${arabicNumber(minutes)} ${minutes === 1 ? 'دقيقة' : 'دقائق'}${seconds ? ` و${arabicNumber(seconds)} ثانية` : ''}`;
  return `${arabicNumber(seconds)} ${seconds === 1 ? 'ثانية' : 'ثواني'}`;
}
function parseDuration(value = '10m') {
  const match = String(value).toLowerCase().match(/^(\d+(?:\.\d+)?)(s|m|h|d|ث|د|س|ي)?$/);
  if (!match) return 10 * 60 * 1000;
  const multiplier = { s: 1000, ث: 1000, m: 60000, د: 60000, h: 3600000, س: 3600000, d: 86400000, ي: 86400000 }[match[2] || 'm'];
  return Math.min(Math.max(Number(match[1]) * multiplier, 5000), 28 * 86400000);
}
function card(title, description, color = COLOR) { return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: 'نظام الإدارة العربي • تم التنفيذ بنجاح' }).setTimestamp(); }
function serverEmoji(guild, name, fallback = '') {
  return guild?.emojis.cache.find(emoji => emoji.name?.toLowerCase() === name.toLowerCase())?.toString() || fallback;
}
function actionMessage(guild, text) {
  const fever = serverEmoji(guild, 'FEVER', '');
  const vxy = serverEmoji(guild, 'Vxy', '');
  return `${fever} ${text} ${vxy}`.trim();
}
function channelResponse(ctx, payload) {
  return ctx.isChatInputCommand?.() ? ctx.reply(payload) : ctx.channel.send(payload);
}
function settingKey(guildIdValue, name) { return key(guildIdValue, name); }
function getGuildSetting(guildIdValue, settingName, fallback = null) {
  const value = store.read().settings[settingKey(guildIdValue, settingName)];
  return value ?? fallback;
}
function shouldSendAutoLine(message) {
  if (!message.guild) return false;
  if (message.channel.id === FEEDBACK_CHANNEL_ID) return true;
  const configuredChannel = getGuildSetting(message.guild.id, 'add-autoline-channel');
  return configuredChannel === message.channel.id && getGuildSetting(message.guild.id, 'line-mode', false) === true;
}
async function sendAutoLine(message) {
  if (shouldSendAutoLine(message)) await message.channel.send({ files: [LINE_IMAGE_URL] }).catch(() => {});
}

async function execute(name, ctx, args = []) {
  const guild = guildOf(ctx);
  if (!guild && !['avatar', 'banner', 'help'].includes(name)) return reply(ctx, 'هذا الأمر يعمل داخل السيرفر فقط.');
  if (modCommands.has(name) && !isMod(ctx.member)) return;
  if (name === 'help') return reply(ctx, `الأوامر المختصرة:\n${prefix}م / clear → مسح الرسائل\n${prefix}ب / ban → حظر عضو\n${prefix}ط / kick → طرد عضو\n${prefix}ك / timeout → كتم عضو\n${prefix}ق / lock → قفل القناة\n${prefix}فتح / unlock → فتح القناة\n${prefix}قول / say → يكتب رسالة باسم البوت\n${prefix}اقتراحات / suggestion-mode → تفعيل اقتراحات\n${prefix}ضريبة / tax → حساب الضريبة 5%\n${prefix}مساعدة / help → قائمة الأوامر\n\nأوامر الـ Slash تعمل أيضًا بنفس الوظائف.`);
  if (name === 'gend') name = 'gstart';
  if (name === 'ping') return reply(ctx, { embeds: [card('🏓 Ping', `زمن استجابة البوت: **${client.ws.ping}ms**`, 0x57f287)] });
  if (name === 'server') name = 'serverinfo';
  if (name === 'mute') name = 'timeout';
  if (name === 'hide') { await ctx.channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }); return reply(ctx, { embeds: [card(`${EMOJIS.lock} تم إخفاء القناة`, 'تم إخفاء القناة عن الأعضاء بنجاح.')] }); }
  if (name === 'roles') return reply(ctx, { embeds: [card('🎭 رتب السيرفر', guild.roles.cache.filter(role => role.name !== '@everyone').map(role => `${role} • ${role.name}`).slice(0, 50).join('\n') || 'لا توجد رتب إضافية.')] });
  if (['anti-ban', 'anti-bots', 'anti-delete-roles', 'anti-delete-rooms', 'dm-mode', 'feedback-mode', 'line-mode'].includes(name)) {
    const enabled = ctx.isChatInputCommand?.() ? ctx.options.getBoolean('enabled') : ['on', 'true', 'تشغيل'].includes(String(args[0]).toLowerCase());
    store.update(data => { data.settings[key(guild.id, name)] = enabled; });
    return reply(ctx, { embeds: [card(`${enabled ? '✅ تم التفعيل' : '⛔ تم التعطيل'}`, `تم ${enabled ? 'تفعيل' : 'تعطيل'} **${name}** في هذا السيرفر.`, 0x57f287)] });
  }
  if (name === 'add-autoline-channel' || name === 'add-nadeko-room') {
    const channel = ctx.isChatInputCommand?.() ? ctx.options.getChannel('channel') : guild.channels.cache.get(args[0]);
    if (!channel) return reply(ctx, 'حدد القناة المطلوبة.');
    store.update(data => {
      data.settings[key(guild.id, name)] = channel.id;
      if (name === 'add-autoline-channel') data.settings[key(guild.id, 'line-mode')] = true;
    });
    return reply(ctx, `✅ تم ربط القناة ${channel} بالأمر ${name}.`);
  }
  if (name === 'close' || name === 'close-apply') {
    await ctx.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    return reply(ctx, { embeds: [card('🔒 تم إغلاق القناة', 'تم منع إرسال الرسائل في هذه القناة.', 0x57f287)] });
  }
  if (name === 'copy-emoji') {
    const value = ctx.isChatInputCommand?.() ? ctx.options.getString('emoji') : args[0];
    const match = String(value || '').match(/<(a?):[\w~]+:(\d+)>/);
    if (!match) return reply(ctx, 'أرسل منشن إيموجي صالح مثل <:emoji:123456789>.');
    const extension = match[1] ? 'gif' : 'png';
    return reply(ctx, `https://cdn.discordapp.com/emojis/${match[2]}.${extension}?size=1024&quality=lossless`);
  }
  if (name === 'games') return reply(ctx, { embeds: [card('🎮 مركز الألعاب', 'اختر لعبة للفعالية:\n\n🎬 **movie** — خمن الفيلم من الإيموجي\n⚡ **speed** — أسرع شخص يضغط\n🍀 **lucky** — اختر رقمًا محظوظًا\n\nكل جولة لها فائز واحد فقط.', 0x9b59b6)] });
  if (name === 'movie') {
    const question = movieQuestions[Math.floor(Math.random() * movieQuestions.length)];
    const id = gameId();
    const options = [...question.options].sort(() => Math.random() - 0.5);
    activeGames.set(id, { type: 'movie', answer: question.answer, options, winnerId: null, createdAt: Date.now() });
    setTimeout(() => activeGames.delete(id), 120000);
    return channelResponse(ctx, { embeds: [card('🎬 خمن الفيلم', `الفيلم مخفي خلف هذه الإيموجيات:\n\n# ${question.emojis}\n\nأول إجابة صحيحة تفوز!`, 0xf1c40f)], components: [gameButtons('movie', id, options)] });
  }
  if (name === 'speed') {
    const id = gameId();
    const word = speedWords[Math.floor(Math.random() * speedWords.length)];
    activeGames.set(id, { type: 'speed', answer: word, channelId: guild?.id ? ctx.channelId : null, winnerId: null, createdAt: Date.now() });
    setTimeout(() => activeGames.delete(id), 120000);
    return channelResponse(ctx, { embeds: [new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('⚡ تحدي أسرع شخص')
      .setDescription('أول شخص يكتب الكلمة وحدها يفوز!')
      .addFields({ name: 'اكتب هذه الكلمة', value: `\n# **${word}**\n`, inline: false })
      .setFooter({ text: 'اكتبها كما هي بدون أي كلمات إضافية' })] });
  }
  if (name === 'lucky') {
    const id = gameId();
    const answer = Math.floor(Math.random() * 5);
    activeGames.set(id, { type: 'lucky', answer, winnerId: null, createdAt: Date.now() });
    setTimeout(() => activeGames.delete(id), 120000);
    return channelResponse(ctx, { embeds: [card('🍀 الرقم المحظوظ', 'اختر رقمًا من 1 إلى 5. أول اختيار صحيح يفوز!', 0x2ecc71)], components: [gameButtons('lucky', id, ['1', '2', '3', '4', '5'])] });
  }
  if (name === 'add-button' || name === 'add-info-button' || name === 'add-ticket-button') {
    const text = ctx.isChatInputCommand?.() ? (ctx.options.getString('text') || 'اضغط هنا') : args.join(' ') || 'اضغط هنا';
    const customId = name === 'add-ticket-button' ? 'ticket:create' : `${name}:${Buffer.from(text).toString('base64url').slice(0, 70)}`;
    const button = new ButtonBuilder().setCustomId(customId).setLabel(text.slice(0, 80)).setStyle(name === 'add-ticket-button' ? ButtonStyle.Success : ButtonStyle.Primary);
    return channelResponse(ctx, { components: [new ActionRowBuilder().addComponents(button)] });
  }
  if (name === 'new-panel' || name === 'new-apply') {
    const button = new ButtonBuilder().setCustomId(name === 'new-apply' ? 'apply:create' : 'ticket:create').setLabel(name === 'new-apply' ? 'تقديم' : 'فتح تذكرة').setStyle(ButtonStyle.Primary);
    return channelResponse(ctx, { embeds: [card(name === 'new-apply' ? '📨 لوحة التقديم' : '🎫 اللوحة التفاعلية', 'استخدم الزر الموجود بالأسفل.')], components: [new ActionRowBuilder().addComponents(button)] });
  }
  if (name === 'rename') { const newName = ctx.isChatInputCommand?.() ? ctx.options.getString('name') : args.join('-'); if (!newName) return reply(ctx, 'حدد الاسم الجديد للقناة.'); await ctx.channel.setName(newName); return reply(ctx, { embeds: [card('✎ تم تغيير اسم القناة', `الاسم الجديد: **${newName}**`, 0x57f287)] }); }
  if (name === 'nickname') { const member = memberOf(ctx); const newName = ctx.isChatInputCommand?.() ? ctx.options.getString('name') : args.slice(1).join(' '); if (!member) return reply(ctx, 'حدد العضو.'); await member.setNickname(newName || null); return reply(ctx, { embeds: [card('✎ تم تحديث اللقب', `${mention(member)} ${newName ? `لقبه الآن **${newName}**.` : 'تمت إزالة لقبه.'}`, 0x57f287)] }); }
  if (name === 'role') { const member = memberOf(ctx); const role = ctx.isChatInputCommand?.() ? ctx.options.getRole('role') : guild.roles.cache.find(item => item.name === args[1] || item.id === args[1]); const action = ctx.isChatInputCommand?.() ? (ctx.options.getString('action') || 'add') : (args[2] || 'add'); if (!member || !role) return reply(ctx, 'حدد العضو والرتبة.'); if (action === 'remove') await member.roles.remove(role); else await member.roles.add(role); return reply(ctx, { embeds: [card('🎭 تم تحديث الرتبة', `${action === 'remove' ? 'تمت إزالة' : 'تمت إضافة'} رتبة **${role.name}** ${action === 'remove' ? 'من' : 'إلى'} ${mention(member)}.`, 0x57f287)] }); }
  if (name === 'logs-info') return reply(ctx, { embeds: [card('📋 حالة السجلات', 'نظام السجلات الأساسي جاهز. يمكن ربط قناة السجلات من إعدادات السيرفر.', 0x57f287)] });
  if (name === 'protection-status') { const settings = store.read().settings; const active = Object.keys(settings).filter(item => item.startsWith(`${guild.id}:`)); return reply(ctx, { embeds: [card(`${EMOJIS.mod} حالة الحماية`, active.length ? active.map(item => `• ${item.split(':').slice(1).join(':')}`).join('\n') : 'لا توجد حماية مفعلة حاليًا.')] }); }
  if (name === 'line-mode') {
    const value = ctx.isChatInputCommand?.()
      ? (ctx.options.getBoolean('enabled') ?? false)
      : !['off', 'false', '0', 'إيقاف', 'تعطيل'].includes(String(args[0] || 'on').toLowerCase());
    store.update(data => { data.settings[key(guild.id, 'line-mode')] = value; });
    if (value) await ctx.channel.send({ files: [LINE_IMAGE_URL] }).catch(() => {});
    return reply(ctx, { embeds: [card(value ? '✅ تم تفعيل الخط' : '⛔ تم تعطيل الخط', value ? 'تم تفعيل الخط التلقائي لهذا السيرفر.' : 'تم تعطيل الخط التلقائي لهذا السيرفر.', 0x57f287)] });
  }
  if (name === 'set-autoline-line' || name === 'set-feedback-line' || name === 'set-feedback-room' || name === 'set-message') { const value = ctx.isChatInputCommand?.() ? (ctx.options.getBoolean('enabled') ?? ctx.options.getString('text') ?? ctx.options.getChannel('channel')?.id) : args.join(' '); store.update(data => { data.settings[key(guild.id, name)] = value; }); return reply(ctx, { embeds: [card(`${EMOJIS.ok} تم حفظ الإعداد`, 'تم تحديث إعداد هذا السيرفر بنجاح.', 0x57f287)] }); }
  if (name === 'remove-all-tokens' || name === 'remove-token') { store.update(data => { data.settings[key(guild.id, name)] = true; }); return reply(ctx, { embeds: [card(`${EMOJIS.ok} تم تنفيذ الحذف`, name === 'remove-all-tokens' ? 'تم حذف جميع التوكنات المحفوظة.' : 'تم حذف التوكن المحدد.', 0x57f287)] }); }
  if (name === 'remove-autoline-channel' || name === 'remove-nadeko-room') { store.update(data => { delete data.settings[key(guild.id, name.replace('remove-', 'add-'))]; }); return reply(ctx, { embeds: [card(`${EMOJIS.ok} تم حذف الإعداد`, 'تمت إزالة إعداد القناة بنجاح.', 0x57f287)] }); }
  if (name === 'tax') {
    if (ctx.channel?.id !== TAX_CHANNEL_ID) return reply(ctx, `استخدم أمر الضريبة في روم <#${TAX_CHANNEL_ID}> فقط.`);
    const input = ctx.isChatInputCommand?.() ? ctx.options.getString('amount') : args[0];
    const netAmount = parseCreditAmount(input);
    if (!netAmount) return reply(ctx, { content: 'صيغة غير صحيحة', allowedMentions: { repliedUser: false } });
    const buyerAmount = Math.ceil(netAmount / (1 - TAX_RATE));
    return reply(ctx, { content: `${buyerAmount.toLocaleString('en-US')}`, allowedMentions: { repliedUser: false } });
  }
  if (name === 'suggestion-mode') {
    const channelSetting = getGuildSetting(guild.id, 'set-suggestions-room');
    store.update(data => { data.settings[key(guild.id, name)] = true; });
    return reply(ctx, {
      embeds: [card('💡 وضع الاقتراحات', channelSetting ? `تم تفعيل وضع الاقتراحات في هذه القناة.\nسيتم إرسال كل اقتراح إلى <@${ownerId}> في الخاص.` : 'تم تفعيل وضع الاقتراحات. الآن حدد قناة الاقتراحات باستخدام الأمر set-suggestions-room أو /set-suggestions-room.', 0x57f287)]
    });
  }
  if (name.startsWith('setup-')) { store.update(data => { data.settings[key(guild.id, name)] = true; }); return reply(ctx, { embeds: [card(`${EMOJIS.ok} تم الإعداد`, `تم تفعيل إعداد **${name.replace('setup-', '')}** بنجاح.`, 0x57f287)] }); }
  if (name.startsWith('set-')) { const setting = ctx.isChatInputCommand?.() ? (ctx.options.getString('text') || ctx.options.getString('shortcut') || ctx.options.getString('command') || ctx.options.getChannel('channel')?.id) : args.join(' '); store.update(data => { data.settings[key(guild.id, name)] = setting; }); if (name === 'set-suggestions-room') { const room = ctx.isChatInputCommand?.() ? ctx.options.getChannel('channel') : guild.channels.cache.get(args[0]); const roomId = room?.id || setting; return reply(ctx, { embeds: [card('💡 تم تحديد قناة الاقتراحات', `تم ربط اقتراحات السيرفر بالقناة <#${roomId}>، وسيتم إرسال كل اقتراح إلى <@${ownerId}> في الخاص.`, 0x57f287)] }); } return reply(ctx, { embeds: [card(`${EMOJIS.ok} تم حفظ الإعداد`, 'تم تحديث إعداد السيرفر بنجاح.', 0x57f287)] }); }
  if (name === 'send' || name === 'say') {
    let text = textOf(ctx, args, 'text');
    if (!text && !ctx.isChatInputCommand?.()) {
      const raw = ctx.content || '';
      text = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
      if (!text) text = raw.replace(/^(say|send|قول|ارسال)\s*[:،\s]*/i, '').trim();
    }
    if (!text) return reply(ctx, 'اكتب نص الرسالة.');
    if (!ctx.isChatInputCommand?.()) await ctx.delete().catch(() => {});
    return channelResponse(ctx, { content: text });
  }
  if (name === 'send-broadcast-panel') { const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('broadcast-confirm').setLabel('تأكيد الإرسال').setStyle(ButtonStyle.Danger)); return channelResponse(ctx, { embeds: [card('📢 لوحة البث', 'اضغط الزر لتأكيد إرسال البث.')], components: [row] }); }
  if (name === 'avatar' || name === 'banner') { const user = userOf(ctx); const fetched = await client.users.fetch(user.id, { force: true }); const url = name === 'banner' ? fetched.bannerURL({ size: 1024, extension: 'png' }) : fetched.displayAvatarURL({ size: 1024, extension: 'png' }); return reply(ctx, url ? { embeds: [new EmbedBuilder().setTitle(name === 'banner' ? `بانر ${user.username}` : `صورة ${user.username}`).setImage(url)] } : 'لا يوجد بانر لهذا العضو.'); }
  if (name === 'clear') { const amount = Math.min(Math.max(numberOf(ctx, args, 'amount', 10), 1), 100); const deleteAmount = ctx.isChatInputCommand?.() ? amount : amount + 1; const messages = await ctx.channel.bulkDelete(deleteAmount, true); const deletedCount = ctx.isChatInputCommand?.() ? messages.size : Math.max(0, messages.size - 1); return temporaryReply(ctx, { embeds: [card(`${EMOJIS.trash} تم تنظيف المحادثة`, `تم حذف **${arabicNumber(deletedCount)}** رسالة بنجاح.`, 0x57f287)] }); }
  if (name === 'delete') return ctx.isChatInputCommand?.() ? reply(ctx, 'استخدم أمر المسح لحذف الرسائل؛ لا يمكن حذف رسالة Slash.') : ctx.delete().catch(() => {});
  if (name === 'unban') {
    const userId = ctx.isChatInputCommand?.() ? ctx.options.getString('user') : args[0];
    if (!/^\d{15,20}$/.test(userId || '')) return reply(ctx, 'اكتب معرف المستخدم الرقمي لإزالة الحظر.');
    await guild.members.unban(userId, 'إزالة الحظر بواسطة البوت');
    return reply(ctx, { embeds: [card('✅ تمت إزالة الحظر', `تم فك الحظر عن المستخدم \`${userId}\` بنجاح.`, 0x57f287)] });
  }
  if (name === 'ban' || name === 'kick') { const member = memberOf(ctx); if (!member) return temporaryReply(ctx, { embeds: [card(`${EMOJIS.error} طريقة الاستخدام`, 'حدد العضو باستخدام منشن أو أمر Slash.', 0xed4245)] }); if (name === 'ban' && !member.bannable) return temporaryReply(ctx, { embeds: [card(`${EMOJIS.error} تعذّر الحظر`, 'رتبة العضو أعلى من رتبة البوت.', 0xed4245)] }); if (name === 'kick' && !member.kickable) return temporaryReply(ctx, { embeds: [card(`${EMOJIS.error} تعذّر الطرد`, 'رتبة العضو أعلى من رتبة البوت.', 0xed4245)] }); const reason = ctx.isChatInputCommand?.() ? ctx.options.getString('reason') : args.slice(1).join(' '); await (name === 'ban' ? member.ban({ reason: reason || 'لم يتم ذكر سبب' }) : member.kick(reason || 'لم يتم ذكر سبب')); return temporaryReply(ctx, { embeds: [card(name === 'ban' ? `${EMOJIS.ban} تم الحظر بنجاح` : `${EMOJIS.kick} تم الطرد بنجاح`, `${name === 'ban' ? 'تم حظر' : 'تم طرد'} العضو ${mention(member)} من السيرفر.\n\n**السبب:** ${reason || 'لم يتم ذكر سبب'}`, 0xed4245)] }); }
  if (name === 'timeout' || name === 'untimeout') { const member = memberOf(ctx); if (!member) return temporaryReply(ctx, { embeds: [card(`${EMOJIS.error} طريقة الاستخدام`, 'حدد العضو باستخدام منشن أو أمر Slash.', 0xed4245)] }); if (!member.moderatable) return temporaryReply(ctx, { embeds: [card(`${EMOJIS.error} تعذّر تعديل الإسكات`, 'رتبة العضو أعلى من رتبة البوت.', 0xed4245)] }); const duration = ctx.isChatInputCommand?.() ? Math.min(ctx.options.getInteger('minutes') || 10, 40320) * 60000 : parseDuration(args[1] || '10m'); if (name === 'untimeout') { await member.timeout(null, 'تم فك الإسكات بواسطة البوت'); return temporaryReply(ctx, { embeds: [card(`${EMOJIS.ok} تم فك الإسكات`, `تم فك الإسكات عن ${mention(member)} بنجاح.`, 0x57f287)] }); } await member.timeout(duration, 'تم الإسكات بواسطة البوت'); return temporaryReply(ctx, { embeds: [card(`${EMOJIS.time} تم إسكات العضو`, `تم إسكات العضو ${mention(member)} لمدة **${prettyDuration(duration)}**.`, 0xfee75c)] }); }
  if (name === 'lock' || name === 'unlock') { await ctx.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: name === 'unlock' }); return temporaryReply(ctx, { embeds: [card(name === 'lock' ? `${EMOJIS.lock} تم قفل القناة` : `${EMOJIS.unlock} تم فتح القناة`, name === 'lock' ? 'تم منع إرسال الرسائل في هذه القناة.' : 'تم السماح بإرسال الرسائل في هذه القناة.', name === 'lock' ? COLOR : 0x57f287)] }); }
  if (name === 'add-user' || name === 'remove-user') { const member = memberOf(ctx); if (!member) return reply(ctx, 'حدد العضو باستخدام منشن أو أمر Slash.'); const canWrite = name === 'add-user'; await ctx.channel.permissionOverwrites.edit(member, { ViewChannel: canWrite, ReadMessageHistory: canWrite, SendMessages: canWrite, SendMessagesInThreads: canWrite, AttachFiles: canWrite, EmbedLinks: canWrite }); return reply(ctx, canWrite ? `✅ تمت إضافة ${member} ويمكنه الكتابة في هذه القناة.` : `✅ تمت إزالة ${member}.`); }
  if (name === 'userinfo') { const member = memberOf(ctx) || ctx.member; return reply(ctx, { embeds: [new EmbedBuilder().setTitle(`معلومات ${member.user.tag}`).setThumbnail(member.user.displayAvatarURL()).addFields({ name: 'المعرف', value: member.id }, { name: 'انضمام', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` })] }); }
  if (name === 'serverinfo') return reply(ctx, { embeds: [new EmbedBuilder().setTitle(guild.name).addFields({ name: 'الأعضاء', value: String(guild.memberCount), inline: true }, { name: 'القنوات', value: String(guild.channels.cache.size), inline: true }, { name: 'المالك', value: `<@${guild.ownerId}>`, inline: true })] });
  if (name === 'say') { const text = textOf(ctx, args, 'text'); if (!ctx.isChatInputCommand?.()) await ctx.delete().catch(() => {}); return channelResponse(ctx, { content: text }); }
  if (name === 'embed') {
    let text;
    let colorInput;
    if (ctx.isChatInputCommand?.()) {
      text = ctx.options.getString('text') || '';
      colorInput = ctx.options.getString('color') || '';
    } else {
      const possibleColor = parseEmbedColor(args[0]);
      colorInput = possibleColor === null ? '' : args.shift();
      text = args.join(' ').trim();
    }
    if (!text) return reply(ctx, 'اكتب نص الإيمبد.');
    const color = parseEmbedColor(colorInput);
    if (color === null) return reply(ctx, 'اللون غير صحيح. استخدم Hex مثل #ff0000 أو اسم لون.');
    if (!ctx.isChatInputCommand?.()) await ctx.delete().catch(() => {});
    return channelResponse(ctx, { embeds: [new EmbedBuilder().setColor(color).setDescription(text)] });
  }
  if (name === 'come') {
    const member = memberOf(ctx);
    if (!member) return reply(ctx, 'حدد الشخص الذي تريد استدعاؤه.');
    const channel = guild.channels.cache.get(ctx.channelId);
    const requester = ctx.user || ctx.author;
    const sentAt = Math.floor(Date.now() / 1000);
    const comeEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('📣 استدعاء مباشر')
      .setDescription(`مرحبًا ${mention(member)}، يُرجى التوجه إلى الروم الآن.`)
      .addFields(
        { name: '👤 طلب الحضور من', value: `${mention(requester)}`, inline: true },
        { name: '📍 الروم', value: `${channel ? `<#${channel.id}>` : 'الروم الحالي'}\n${channel ? `https://discord.com/channels/${guild.id}/${channel.id}` : ''}`, inline: true },
        { name: '🕒 وقت الإرسال', value: `<t:${sentAt}:F>\n<t:${sentAt}:R>`, inline: true }
      )
      .setFooter({ text: 'Nexora Store • استدعاء إداري' })
      .setTimestamp();
    await member.send({ embeds: [comeEmbed] }).catch(() => {});
    if (!ctx.isChatInputCommand?.()) await ctx.delete().catch(() => {});
    return reply(ctx, { embeds: [card('✅ تم إرسال الاستدعاء', `تم إرسال استدعاء أنيق إلى ${mention(member)} مع رابط الروم ووقت الطلب.`, 0x57f287)] });
  }
  if (name === 'warn') {
    const member = memberOf(ctx);
    if (!member) return temporaryReply(ctx, 'حدد العضو.');
    await member.send(`⚠️ تنبيه: تم تحذيرك من السيرفر، الرجاء الالتزام بالقوانين.`).catch(() => {});
    return temporaryReply(ctx, `✅ تم إرسال تحذير إلى ${member}.`);
  }
  if (name === 'autoreply-add') { const trigger = ctx.isChatInputCommand?.() ? ctx.options.getString('trigger') : args[0]; const value = ctx.isChatInputCommand?.() ? ctx.options.getString('reply') : args.slice(1).join(' '); if (!trigger || !value) return reply(ctx, `استخدم: ${prefix}رد الكلمة الرد`); store.update(s => { s.autoreplies[key(guild.id, trigger.toLowerCase())] = value; }); return reply(ctx, '✅ تمت إضافة الرد التلقائي.'); }
  if (name === 'autoreply-list') { const rows = Object.entries(store.read().autoreplies).filter(([k]) => k.startsWith(`${guild.id}:`)).map(([k, v]) => `• **${k.split(':').slice(1).join(':')}** ← ${v}`); return reply(ctx, rows.length ? rows.join('\n') : 'لا توجد ردود تلقائية.'); }
  if (name === 'autoreply-remove') { const trigger = ctx.isChatInputCommand?.() ? ctx.options.getString('trigger') : args[0]; store.update(s => { delete s.autoreplies[key(guild.id, trigger.toLowerCase())]; }); return reply(ctx, '✅ تم حذف الرد إن كان موجودًا.'); }
  if (name === 'gstart') { const seconds = Math.max(5, numberOf(ctx, args, 'seconds', 60)); const prize = ctx.isChatInputCommand?.() ? ctx.options.getString('prize') : args.slice(1).join(' ') || 'جائزة'; if (ctx.isChatInputCommand?.()) await ctx.deferReply(); const msg = await ctx.channel.send(`🎉 **سحب جديد!**\nالجائزة: **${prize}**\nتفاعل بـ 🎉 خلال ${seconds} ثانية للفوز.`); await msg.react('🎉'); if (ctx.isChatInputCommand?.()) await ctx.editReply(`✅ تم إنشاء السحب: ${msg.url}`); setTimeout(async () => { const fresh = await ctx.channel.messages.fetch(msg.id).catch(() => null); const users = fresh ? await fresh.reactions.cache.get('🎉')?.users.fetch() : null; const winner = users?.filter(u => !u.bot).random(); await ctx.channel.send(winner ? `🏆 الفائز هو ${winner}!` : 'لم يشارك أحد في السحب.'); }, seconds * 1000); }
  if (name === 'greroll') {
    const messageId = ctx.isChatInputCommand?.() ? ctx.options.getString('message') : args[0];
    const giveaway = await ctx.channel.messages.fetch(messageId).catch(() => null);
    const users = giveaway ? await giveaway.reactions.cache.get('🎉')?.users.fetch() : null;
    const winner = users?.filter(user => !user.bot).random();
    return reply(ctx, winner ? `🏆 الفائز الجديد هو ${winner}.` : 'لم يتم العثور على مشاركين في السحب.');
  }
}

client.once('ready', async () => { const rest = new REST({ version: '10' }).setToken(token); const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId); await rest.put(route, { body: slashCommands }); console.log(`✅ Logged in as ${client.user.tag}; ${slashCommands.length} slash commands registered.`); });
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!claimMessage(message.id)) return;
  if (processedMessageIds.has(message.id)) return;
  processedMessageIds.set(message.id, Date.now());
  setTimeout(() => processedMessageIds.delete(message.id), 60000);
  const rawContent = message.content.trim();
  const parsed = parseCommand(rawContent);

  if (parsed) {
    try {
      await execute(parsed.name, message, parsed.args);
    } catch (error) {
      console.error(error);
      reply(message, 'حدث خطأ. تحقق من صلاحيات البوت.').catch(() => {});
    }
    await message.delete().catch(() => {});
    return;
  }

  if (message.guild) {
    const speedGame = [...activeGames.entries()].find(([, game]) => game.type === 'speed' && game.channelId === message.channelId && !game.winnerId);
    if (speedGame && message.content.trim() === speedGame[1].answer) {
      const [id, game] = speedGame;
      game.winnerId = message.author.id;
      activeGames.delete(id);
      await message.channel.send({ embeds: [gameWinnerEmbed('فائز لعبة السرعة', message.author, `الكلمة الصحيحة كانت: **${game.answer}**`)] });
      return;
    }
    if (message.channel.id === FEEDBACK_CHANNEL_ID && message.content.trim()) {
      if (await feedbackAlreadyHandled(message)) {
        await message.delete().catch(() => {});
        return;
      }
      const feedbackEmbed = new EmbedBuilder()
        .setColor(0x8f1d2c)
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL({ size: 128 }) })
        .setDescription(message.content.trim())
        .setFooter({ text: 'Nexora Store • رأيك يهمنا' })
        .setTimestamp();
      await sendFeedbackMessage(message.channel, { content: `شكراً لرأيك ${message.author} 🤍`, embeds: [feedbackEmbed], allowedMentions: { users: [message.author.id] } }, message.id);
      await sendFeedbackMessage(message.channel, { files: [LINE_IMAGE_URL], allowedMentions: { parse: [] } }, message.id);
      await new Promise(resolve => setTimeout(resolve, 500));
      await removeDuplicateFeedbackReplies(message);
      await message.delete().catch(() => {});
      return;
    }

    const auto = store.read().autoreplies[key(message.guild.id, message.content.toLowerCase())];
    if (auto) await message.reply({ content: auto, allowedMentions: { parse: [], repliedUser: false } });

    const suggestionsRoomId = getGuildSetting(message.guild.id, 'set-suggestions-room');
    const suggestionModeEnabled = getGuildSetting(message.guild.id, 'suggestion-mode', false);
    if (suggestionModeEnabled && suggestionsRoomId && message.channel.id === suggestionsRoomId) {
      const suggestionText = message.content.trim();
      if (suggestionText) {
        const ownerUser = await client.users.fetch(ownerId).catch(() => null);
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('💡 اقتراح جديد')
          .setDescription(suggestionText)
          .addFields(
            { name: 'المرسل', value: `<@${message.author.id}>`, inline: true },
            { name: 'القناة', value: `<#${message.channel.id}>`, inline: true },
            { name: 'التاريخ', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true }
          );
        if (ownerUser) {
          await ownerUser.send({ embeds: [embed] }).catch(() => {});
        }
        await message.reply({ content: '✅ تم إرسال اقتراحك بنجاح، وسيصل إلى المالك في الخاص.', allowedMentions: { repliedUser: false } }).catch(() => {});
      }
    }
    await sendAutoLine(message);
  }
  if (message.guild && message.channel.id === TAX_CHANNEL_ID && parseCreditAmount(message.content)) {
    try {
      const amount = parseCreditAmount(message.content);
      const buyerAmount = Math.ceil(amount / (1 - TAX_RATE));
      await message.reply({ content: `${buyerAmount.toLocaleString('en-US')}`, allowedMentions: { repliedUser: false } });
    } catch (error) { console.error(error); }
    return;
  }
});
client.on('interactionCreate', async interaction => {
  if (!claimInteraction(interaction.id)) return;
  if (processedInteractionIds.has(interaction.id)) return;
  processedInteractionIds.add(interaction.id);
  setTimeout(() => processedInteractionIds.delete(interaction.id), 60000);
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('game:')) {
        const [, type, id, indexText] = interaction.customId.split(':');
        const game = activeGames.get(id);
        if (!game || game.winnerId) return interaction.reply({ content: 'انتهت هذه الجولة أو فاز بها شخص آخر.', ephemeral: true });
        const index = Number(indexText);
        const correct = type === 'movie' && game.options[index] === game.answer || type === 'lucky' && index === game.answer;
        if (!correct) return interaction.reply({ content: 'ليست الإجابة الصحيحة، حاول في جولة أخرى.', ephemeral: true });
        game.winnerId = interaction.user.id;
        activeGames.delete(id);
        const winnerEmbed = gameWinnerEmbed(type === 'movie' ? 'فائز لعبة الفيلم' : 'فائز الرقم المحظوظ', interaction.user, type === 'movie' ? `الإجابة الصحيحة: **${game.answer}**` : `الرقم الفائز: **${game.answer + 1}**`);
        await interaction.update({ embeds: [winnerEmbed], components: [gameButtons(type, id, type === 'movie' ? game.options : ['1', '2', '3', '4', '5'], true)] }).catch(() => {});
        return;
      }
      if (interaction.customId.startsWith('add-info-button:')) {
        const encoded = interaction.customId.split(':')[1] || '';
        const text = Buffer.from(encoded, 'base64url').toString('utf8');
        return reply(interaction, text);
      }
      if (interaction.customId.startsWith('add-button:')) return reply(interaction, '✅ تم الضغط على الزر.');
      if (interaction.customId === 'ticket:create' || interaction.customId === 'apply:create') {
        const channelName = `${interaction.customId === 'apply:create' ? 'apply' : 'ticket'}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90);
        const created = await interaction.guild.channels.create({
          name: channelName,
          type: 0,
          permissionOverwrites: [
            { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }
          ]
        });
        return reply(interaction, `✅ تم إنشاء ${created}.`);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    await execute(interaction.commandName, interaction);
  } catch (error) {
    console.error(error);
    const text = 'حدث خطأ أثناء تنفيذ الأمر.';
    if (interaction.replied || interaction.deferred) await interaction.followUp(text).catch(() => {});
    else await interaction.reply(text).catch(() => {});
  }
});
+process.on('unhandledRejection', console.error);
+client.login(token);
