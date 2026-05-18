// ============================================================
// LINE Bot - ระบบจองห้องนวด (v2)
// ✅ แจ้งเตือนก่อนนัด 1 ชั่วโมง + 15 นาที
// ✅ ยกเลิกการจองพร้อม notify คนรอคิว
// ============================================================
// npm install @line/bot-sdk express node-cron
// ============================================================

const express = require("express");
const line = require("@line/bot-sdk");
const cron = require("node-cron");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "YOUR_CHANNEL_ACCESS_TOKEN",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "YOUR_CHANNEL_SECRET",
};
const client = new line.Client(config);

// ============================================================
// CONFIG
// ============================================================
const ROOMS = ["ห้อง A", "ห้อง B", "ห้อง C", "ห้อง D"];
const SLOTS = ["10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00"];
const REMIND_BEFORE_MIN = [60, 15]; // แจ้งเตือนก่อน 60 และ 15 นาที

// ============================================================
// DATA STORE (in-memory — swap ด้วย DB ได้)
// ============================================================

// bookingList: { bookingId: { userId, date, time, room, status, remindedAt: Set } }
const bookingList = {};

// waitlist: คนรอห้องว่าง { "YYYY-MM-DD|HH:MM": [userId, ...] }
const waitlist = {};

// session state
const pendingBooking = {};
const pendingCancel = {};  // { userId: { step, bookingId } }

let bookingCounter = 1000;

// ============================================================
// HELPERS
// ============================================================

function genBookingId() { return `BK${++bookingCounter}`; }
function getTodayStr() { return new Date().toISOString().split("T")[0]; }

function getTomorrowStr() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

function formatDateTH(dateStr) {
  const [y, m, d] = dateStr.split("-");
  const months = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  return `${parseInt(d)} ${months[parseInt(m)-1]} ${parseInt(y)+543}`;
}

function getBookedRooms(dateStr, timeSlot) {
  return Object.values(bookingList)
    .filter(b => b.date === dateStr && b.time === timeSlot && b.status === "active")
    .map(b => b.room);
}

function getAvailableRooms(dateStr, timeSlot) {
  const booked = getBookedRooms(dateStr, timeSlot);
  return ROOMS.filter(r => !booked.includes(r));
}

function getAvailableSlots(dateStr) {
  return SLOTS.filter(slot => getAvailableRooms(dateStr, slot).length > 0);
}

function isFullyBooked(dateStr) { return getAvailableSlots(dateStr).length === 0; }

function getUserActiveBookings(userId) {
  return Object.entries(bookingList)
    .filter(([, b]) => b.userId === userId && b.status === "active")
    .map(([id, b]) => ({ bookingId: id, ...b }));
}

function getCurrentTimeSlot() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  for (let i = SLOTS.length - 1; i >= 0; i--) {
    if (SLOTS[i] <= hhmm) return SLOTS[i];
  }
  return null;
}

// ใช้เวลา UTC+7 (ปรับตาม timezone server)
function nowTH() {
  const d = new Date();
  // ถ้า server เป็น UTC ให้ uncomment บรรทัดนี้:
  // d.setHours(d.getHours() + 7);
  return d;
}

// ============================================================
// WAITLIST — แจ้งเมื่อมีการยกเลิก
// ============================================================

function addToWaitlist(userId, dateStr, timeSlot) {
  const key = `${dateStr}|${timeSlot}`;
  if (!waitlist[key]) waitlist[key] = [];
  if (!waitlist[key].includes(userId)) waitlist[key].push(userId);
}

async function notifyWaitlist(dateStr, timeSlot) {
  const key = `${dateStr}|${timeSlot}`;
  const users = waitlist[key] || [];
  if (!users.length) return;

  const dateTH = formatDateTH(dateStr);
  for (const uid of users) {
    try {
      await client.pushMessage(uid, {
        type: "template",
        altText: `🔔 มีห้องว่าง ${timeSlot} น.`,
        template: {
          type: "confirm",
          text: `🔔 มีห้องว่างแล้วค่ะ!\n\n📅 ${dateTH}\n⏰ ${timeSlot} น.\n\nต้องการจองไหมคะ?`,
          actions: [
            { type: "message", label: "✅ จองเลย!", text: "จองห้องนวด" },
            { type: "message", label: "ไม่ต้องแล้ว", text: "ไม่ต้องการ" },
          ],
        },
      });
    } catch (e) {
      console.error("Notify waitlist error:", e.message);
    }
  }
  delete waitlist[key]; // ล้าง waitlist หลัง notify
}

// ============================================================
// REMINDER SCHEDULER — ทำงานทุก 1 นาที
// ============================================================

cron.schedule("* * * * *", async () => {
  const now = nowTH();
  const todayStr = now.toISOString().split("T")[0];
  const currentHHMM = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

  for (const [bookingId, b] of Object.entries(bookingList)) {
    if (b.status !== "active" || b.date !== todayStr) continue;

    for (const minBefore of REMIND_BEFORE_MIN) {
      const remindKey = `remind_${minBefore}`;
      if (b.remindedAt && b.remindedAt.has(remindKey)) continue;

      // คำนวณเวลาที่ต้อง push reminder
      const [slotH, slotM] = b.time.split(":").map(Number);
      const remindTotalMin = slotH * 60 + slotM - minBefore;
      const remindHHMM = `${String(Math.floor(remindTotalMin / 60)).padStart(2,"0")}:${String(remindTotalMin % 60).padStart(2,"0")}`;

      if (currentHHMM === remindHHMM) {
        try {
          const msg = minBefore === 60
            ? `🔔 แจ้งเตือน! อีก 1 ชั่วโมงถึงเวลานวดค่ะ\n\n📅 ${formatDateTH(b.date)}\n⏰ ${b.time} น.\n🛁 ${b.room}\n\nหากต้องการยกเลิก พิมพ์ "ยกเลิกการจอง"`
            : `⏰ เตือน! อีก 15 นาทีถึงเวลานวดแล้วค่ะ\n\n📅 ${formatDateTH(b.date)}\n⏰ ${b.time} น.\n🛁 ${b.room}\n\nเตรียมตัวมาได้เลยนะคะ 🙏✨`;

          await client.pushMessage(b.userId, { type: "text", text: msg });
          bookingList[bookingId].remindedAt.add(remindKey);
        } catch (e) {
          console.error("Reminder error:", e.message);
        }
      }
    }
  }
});

// ============================================================
// CANCELLATION FLOW
// ============================================================

async function startCancelFlow(event, userId) {
  const active = getUserActiveBookings(userId);
  if (!active.length) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ไม่พบการจองที่ active อยู่ค่ะ 🙏\nพิมพ์ 'จองห้องนวด' เพื่อจองใหม่ได้เลยค่ะ",
    });
  }

  const quickItems = active.map(b => ({
    type: "action",
    action: { type: "message", label: `${b.time} ${b.room}`, text: `ยกเลิกรหัส:${b.bookingId}` },
  }));

  const list = active
    .map(b => `🔖 ${b.bookingId}\n   📅 ${formatDateTH(b.date)}\n   ⏰ ${b.time} น.  🛁 ${b.room}`)
    .join("\n\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📋 การจองของคุณ:\n\n${list}\n\nเลือกรายการที่ต้องการยกเลิกค่ะ 👇`,
    quickReply: { items: quickItems },
  });
}

async function confirmCancel(event, userId, bookingId) {
  const b = bookingList[bookingId];
  if (!b || b.userId !== userId || b.status !== "active") {
    return client.replyMessage(event.replyToken, { type: "text", text: "❌ ไม่พบการจองนี้ค่ะ" });
  }
  pendingCancel[userId] = { step: "confirm", bookingId };

  return client.replyMessage(event.replyToken, {
    type: "template",
    altText: "ยืนยันการยกเลิก",
    template: {
      type: "confirm",
      text: `⚠️ ยืนยันยกเลิกการจอง?\n\n📅 ${formatDateTH(b.date)}\n⏰ ${b.time} น.\n🛁 ${b.room}`,
      actions: [
        { type: "message", label: "✅ ยืนยันยกเลิก", text: "ยืนยันยกเลิกจอง" },
        { type: "message", label: "↩️ ไม่ยกเลิก", text: "ไม่ยกเลิก" },
      ],
    },
  });
}

async function executeCancellation(event, userId) {
  const state = pendingCancel[userId];
  if (!state) return;
  const { bookingId } = state;
  const b = bookingList[bookingId];
  delete pendingCancel[userId];

  if (!b || b.status !== "active") {
    return client.replyMessage(event.replyToken, { type: "text", text: "❌ ไม่พบการจองนี้ค่ะ" });
  }

  bookingList[bookingId].status = "cancelled";

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ ยกเลิกการจองสำเร็จค่ะ\n\n📅 ${formatDateTH(b.date)}\n⏰ ${b.time} น.\n🛁 ${b.room}\n\nขอบคุณที่แจ้งล่วงหน้านะคะ 🙏`,
  });

  // แจ้ง waitlist ทันที
  await notifyWaitlist(b.date, b.time);
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

async function handleMessage(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const lower = text.toLowerCase();

  // --- Cancel confirm flow ---
  if (pendingCancel[userId]) {
    if (text === "ยืนยันยกเลิกจอง") return executeCancellation(event, userId);
    if (text === "ไม่ยกเลิก") {
      delete pendingCancel[userId];
      return client.replyMessage(event.replyToken, { type: "text", text: "ยังคงการจองไว้เหมือนเดิมนะคะ 😊" });
    }
    const m = text.match(/^ยกเลิกรหัส:(BK\d+)$/);
    if (m) return confirmCancel(event, userId, m[1]);
  }

  // --- Booking flow ---
  if (pendingBooking[userId]) return handleBookingFlow(event, userId, text);

  // --- Cancel select ---
  const cancelMatch = text.match(/^ยกเลิกรหัส:(BK\d+)$/);
  if (cancelMatch) return confirmCancel(event, userId, cancelMatch[1]);

  // --- Keywords ---
  if (/(ยกเลิก)/.test(lower) && !/(ไม่ยกเลิก)/.test(lower)) return startCancelFlow(event, userId);
  if (/(จอง|book|reserve)/.test(lower) && !/(ยกเลิก)/.test(lower)) return sendBookingStart(event, userId);
  if (/(walk.?in|วอล์ค|มาเลย|ตอนนี้|ห้องว่าง|มีห้อง)/.test(lower)) return sendWalkInStatus(event);
  if (/(เช็ค|check|สถานะ|ว่าง|เต็ม|พรุ่งนี้)/.test(lower)) return sendTomorrowStatus(event);
  if (/(การจองของฉัน|ดูการจอง)/.test(lower)) return sendMyBookings(event, userId);

  return sendMainMenu(event);
}

// ============================================================
// HANDLERS
// ============================================================

async function sendMainMenu(event) {
  return client.replyMessage(event.replyToken, {
    type: "template",
    altText: "เมนูหลัก - ระบบจองห้องนวด",
    template: {
      type: "buttons",
      thumbnailImageUrl: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800&q=80",
      imageAspectRatio: "rectangle",
      imageSize: "cover",
      title: "🛁 ระบบจองห้องนวด",
      text: "ยินดีต้อนรับ! ต้องการทำอะไร?",
      actions: [
        { type: "message", label: "📅 จองล่วงหน้า", text: "จองห้องนวด" },
        { type: "message", label: "🚶 Walk-in เช็คห้องว่าง", text: "walk in" },
        { type: "message", label: "❌ ยกเลิกการจอง", text: "ยกเลิกการจอง" },
        { type: "message", label: "📋 ดูการจองของฉัน", text: "การจองของฉัน" },
      ],
    },
  });
}

async function sendMyBookings(event, userId) {
  const active = getUserActiveBookings(userId);
  if (!active.length) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ยังไม่มีการจองที่ active อยู่ค่ะ 🙏\nพิมพ์ 'จองห้องนวด' เพื่อจองค่ะ",
    });
  }
  const list = active
    .map(b => `🔖 ${b.bookingId}\n   📅 ${formatDateTH(b.date)}\n   ⏰ ${b.time} น.  🛁 ${b.room}`)
    .join("\n\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📋 การจองของคุณ:\n\n${list}\n\nต้องการยกเลิก พิมพ์ "ยกเลิกการจอง" ค่ะ`,
  });
}

async function sendWalkInStatus(event) {
  const today = getTodayStr();
  const currentSlot = getCurrentTimeSlot();

  if (!currentSlot) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "⏰ ขณะนี้ยังไม่เปิดให้บริการ (เปิด 10:00 - 20:00 น.)",
    });
  }

  const available = getAvailableRooms(today, currentSlot);
  if (!available.length) {
    // ลง waitlist อัตโนมัติ
    addToWaitlist(event.source.userId, today, currentSlot);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `😔 ขออภัยค่ะ เวลา ${currentSlot} น. วันนี้\n❌ ห้องเต็มทุกห้องแล้วค่ะ\n\n📩 เราจะแจ้งเตือนทันทีเมื่อมีการยกเลิกค่ะ ✨`,
    });
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ มีห้องว่างค่ะ!\n\nเวลา: ${currentSlot} น. (วันนี้)\nห้องที่ว่าง:\n${available.map(r => `• ${r}`).join("\n")}\n\n📍 เดินเข้ามาได้เลยค่ะ 🙏`,
  });
}

async function sendTomorrowStatus(event) {
  const tomorrow = getTomorrowStr();
  const dateTH = formatDateTH(tomorrow);

  if (isFullyBooked(tomorrow)) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `📅 วันพรุ่งนี้ (${dateTH})\n\n❌ ห้องเต็มทุกช่วงเวลาแล้วค่ะ`,
    });
  }

  const freeSlots = getAvailableSlots(tomorrow);
  const slotList = freeSlots
    .map(slot => `🕐 ${slot} น. — ว่าง ${getAvailableRooms(tomorrow, slot).length} ห้อง`)
    .join("\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📅 วันพรุ่งนี้ (${dateTH})\n\nช่วงเวลาที่ว่าง:\n${slotList}\n\nพิมพ์ "จองห้องนวด" เพื่อจองได้เลยค่ะ ✨`,
  });
}

async function sendBookingStart(event, userId) {
  const tomorrow = getTomorrowStr();
  if (isFullyBooked(tomorrow)) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `😔 วันพรุ่งนี้ห้องเต็มทุกช่วงเวลาแล้วค่ะ`,
    });
  }

  const freeSlots = getAvailableSlots(tomorrow);
  pendingBooking[userId] = { step: "choose_time", date: tomorrow };

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📅 จองห้องนวด วันพรุ่งนี้ (${formatDateTH(tomorrow)})\n\nกรุณาเลือกช่วงเวลาค่ะ 👇`,
    quickReply: {
      items: freeSlots.slice(0, 13).map(slot => ({
        type: "action",
        action: { type: "message", label: slot, text: `เลือกเวลา:${slot}` },
      })),
    },
  });
}

async function handleBookingFlow(event, userId, text) {
  const state = pendingBooking[userId];

  if (state.step === "choose_time") {
    const match = text.match(/^เลือกเวลา:(\d{2}:\d{2})$/);
    if (!match) return client.replyMessage(event.replyToken, { type: "text", text: "กรุณาเลือกเวลาจากปุ่มด้านบนค่ะ 🙏" });

    const time = match[1];
    const available = getAvailableRooms(state.date, time);
    if (!available.length) {
      delete pendingBooking[userId];
      return client.replyMessage(event.replyToken, { type: "text", text: `❌ เวลา ${time} น. ห้องเต็มแล้วค่ะ กรุณาเริ่มใหม่` });
    }

    pendingBooking[userId] = { ...state, step: "choose_room", time };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `🛁 เวลา ${time} น. มีห้องว่าง ${available.length} ห้องค่ะ\n\nเลือกห้องได้เลยค่ะ 👇`,
      quickReply: {
        items: available.map(room => ({
          type: "action",
          action: { type: "message", label: room, text: `เลือกห้อง:${room}` },
        })),
      },
    });
  }

  if (state.step === "choose_room") {
    const match = text.match(/^เลือกห้อง:(.+)$/);
    if (!match) return client.replyMessage(event.replyToken, { type: "text", text: "กรุณาเลือกห้องจากปุ่มด้านบนค่ะ 🙏" });

    const room = match[1];
    if (!getAvailableRooms(state.date, state.time).includes(room)) {
      delete pendingBooking[userId];
      return client.replyMessage(event.replyToken, { type: "text", text: "❌ ห้องนี้ถูกจองไปแล้วค่ะ กรุณาเริ่มใหม่" });
    }

    pendingBooking[userId] = { ...state, step: "confirm", room };
    return client.replyMessage(event.replyToken, {
      type: "template",
      altText: "ยืนยันการจอง",
      template: {
        type: "confirm",
        text: `📋 ยืนยันการจองค่ะ\n\n📅 ${formatDateTH(state.date)}\n⏰ ${state.time} น.\n🛁 ${room}`,
        actions: [
          { type: "message", label: "✅ ยืนยัน", text: "ยืนยันการจอง" },
          { type: "message", label: "❌ ยกเลิก", text: "ยกเลิกการจอง" },
        ],
      },
    });
  }

  if (state.step === "confirm") {
    if (text === "ยืนยันการจอง") {
      const bookingId = genBookingId();
      bookingList[bookingId] = {
        userId,
        date: state.date,
        time: state.time,
        room: state.room,
        status: "active",
        remindedAt: new Set(),
        createdAt: new Date().toISOString(),
      };
      delete pendingBooking[userId];

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `🎉 จองสำเร็จค่ะ!\n\n🔖 รหัสจอง: ${bookingId}\n📅 ${formatDateTH(state.date)}\n⏰ ${state.time} น.\n🛁 ${state.room}\n\n🔔 เราจะแจ้งเตือนก่อนนัด 1 ชั่วโมง และ 15 นาทีค่ะ\nขอบคุณที่ใช้บริการ 🙏`,
      });
    } else {
      delete pendingBooking[userId];
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ยกเลิกการจองแล้วค่ะ 👋\nพิมพ์ 'จองห้องนวด' เพื่อจองใหม่ได้เลยนะคะ",
      });
    }
  }
}

// ============================================================
// WEBHOOK
// ============================================================
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleMessage))
    .then(() => res.json({ status: "ok" }))
    .catch(err => { console.error(err); res.status(500).end(); });
});

app.get("/", (_, res) => res.send("LINE Bot Massage Booking v2 ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
