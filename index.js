// ============================================================
// LINE Bot - ระบบจองห้องนวด (v2 FIXED)
// ✅ แก้บัค booking flow ค้าง
// ✅ reset session อัตโนมัติ
// ✅ session timeout 10 นาที
// ✅ ไม่ชน cancel booking
// ============================================================

const express = require("express");
const line = require("@line/bot-sdk");
const cron = require("node-cron");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// ============================================================
// CONFIG
// ============================================================

const ROOMS = ["ห้อง A", "ห้อง B", "ห้อง C", "ห้อง D"];

const SLOTS = [
  "10:00",
  "11:00",
  "12:00",
  "13:00",
  "14:00",
  "15:00",
  "16:00",
  "17:00",
  "18:00",
  "19:00",
  "20:00",
];

const REMIND_BEFORE_MIN = [60, 15];

// ============================================================
// DATA STORE
// ============================================================

const bookingList = {};
const waitlist = {};

const pendingBooking = {};
const pendingCancel = {};

let bookingCounter = 1000;

// ============================================================
// HELPERS
// ============================================================

function genBookingId() {
  return `BK${++bookingCounter}`;
}

function getTodayStr() {
  return new Date().toISOString().split("T")[0];
}

function getTomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

function formatDateTH(dateStr) {
  const [y, m, d] = dateStr.split("-");

  const months = [
    "ม.ค.",
    "ก.พ.",
    "มี.ค.",
    "เม.ย.",
    "พ.ค.",
    "มิ.ย.",
    "ก.ค.",
    "ส.ค.",
    "ก.ย.",
    "ต.ค.",
    "พ.ย.",
    "ธ.ค.",
  ];

  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${
    parseInt(y) + 543
  }`;
}

function getBookedRooms(dateStr, timeSlot) {
  return Object.values(bookingList)
    .filter(
      (b) =>
        b.date === dateStr &&
        b.time === timeSlot &&
        b.status === "active"
    )
    .map((b) => b.room);
}

function getAvailableRooms(dateStr, timeSlot) {
  const booked = getBookedRooms(dateStr, timeSlot);
  return ROOMS.filter((r) => !booked.includes(r));
}

function getAvailableSlots(dateStr) {
  return SLOTS.filter(
    (slot) => getAvailableRooms(dateStr, slot).length > 0
  );
}

function isFullyBooked(dateStr) {
  return getAvailableSlots(dateStr).length === 0;
}

function getUserActiveBookings(userId) {
  return Object.entries(bookingList)
    .filter(
      ([, b]) =>
        b.userId === userId &&
        b.status === "active"
    )
    .map(([id, b]) => ({
      bookingId: id,
      ...b,
    }));
}

function getCurrentTimeSlot() {
  const now = new Date();

  const hhmm = `${String(now.getHours()).padStart(
    2,
    "0"
  )}:${String(now.getMinutes()).padStart(2, "0")}`;

  for (let i = SLOTS.length - 1; i >= 0; i--) {
    if (SLOTS[i] <= hhmm) return SLOTS[i];
  }

  return null;
}

function nowTH() {
  return new Date();
}

// ============================================================
// WAITLIST
// ============================================================

function addToWaitlist(userId, dateStr, timeSlot) {
  const key = `${dateStr}|${timeSlot}`;

  if (!waitlist[key]) {
    waitlist[key] = [];
  }

  if (!waitlist[key].includes(userId)) {
    waitlist[key].push(userId);
  }
}

async function notifyWaitlist(dateStr, timeSlot) {
  const key = `${dateStr}|${timeSlot}`;
  const users = waitlist[key] || [];

  if (!users.length) return;

  const dateTH = formatDateTH(dateStr);

  for (const uid of users) {
    try {
      await client.pushMessage(uid, {
        type: "text",
        text:
          `🔔 มีห้องว่างแล้วค่ะ!\n\n` +
          `📅 ${dateTH}\n` +
          `⏰ ${timeSlot} น.\n\n` +
          `พิมพ์ "จองห้องนวด" เพื่อจองได้เลยค่ะ ✨`,
      });
    } catch (e) {
      console.error(e.message);
    }
  }

  delete waitlist[key];
}

// ============================================================
// REMINDER
// ============================================================

cron.schedule("* * * * *", async () => {
  const now = nowTH();

  const todayStr = now.toISOString().split("T")[0];

  const currentHHMM =
    `${String(now.getHours()).padStart(2, "0")}:` +
    `${String(now.getMinutes()).padStart(2, "0")}`;

  for (const [bookingId, b] of Object.entries(bookingList)) {
    if (
      b.status !== "active" ||
      b.date !== todayStr
    ) {
      continue;
    }

    for (const minBefore of REMIND_BEFORE_MIN) {
      const remindKey = `remind_${minBefore}`;

      if (
        b.remindedAt &&
        b.remindedAt.has(remindKey)
      ) {
        continue;
      }

      const [slotH, slotM] = b.time
        .split(":")
        .map(Number);

      const remindTotalMin =
        slotH * 60 + slotM - minBefore;

      const remindHHMM =
        `${String(
          Math.floor(remindTotalMin / 60)
        ).padStart(2, "0")}:` +
        `${String(remindTotalMin % 60).padStart(
          2,
          "0"
        )}`;

      if (currentHHMM === remindHHMM) {
        try {
          const msg =
            minBefore === 60
              ? `🔔 อีก 1 ชั่วโมงถึงเวลานวดค่ะ`
              : `⏰ อีก 15 นาทีถึงเวลานวดแล้วค่ะ`;

          await client.pushMessage(b.userId, {
            type: "text",
            text:
              `${msg}\n\n` +
              `📅 ${formatDateTH(b.date)}\n` +
              `⏰ ${b.time} น.\n` +
              `🛁 ${b.room}`,
          });

          bookingList[bookingId].remindedAt.add(
            remindKey
          );
        } catch (e) {
          console.error(e.message);
        }
      }
    }
  }
});

// ============================================================
// MAIN MENU
// ============================================================

async function sendMainMenu(event) {
  return client.replyMessage(event.replyToken, {
    type: "template",
    altText: "เมนูหลัก",
    template: {
      type: "buttons",
      title: "🛁 ระบบจองห้องนวด",
      text: "เลือกเมนูที่ต้องการ",
      actions: [
        {
          type: "message",
          label: "📅 จองล่วงหน้า",
          text: "จองห้องนวด",
        },
        {
          type: "message",
          label: "🚶 Walk in",
          text: "walk in",
        },
        {
          type: "message",
          label: "📋 ดูการจอง",
          text: "การจองของฉัน",
        },
        {
          type: "message",
          label: "❌ ยกเลิกการจอง",
          text: "ยกเลิกการจอง",
        },
      ],
    },
  });
}

// ============================================================
// BOOKING START
// ============================================================

async function sendBookingStart(event, userId) {
  const tomorrow = getTomorrowStr();

  if (isFullyBooked(tomorrow)) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ วันพรุ่งนี้เต็มแล้วค่ะ",
    });
  }

  const freeSlots = getAvailableSlots(tomorrow);

  pendingBooking[userId] = {
    step: "choose_time",
    date: tomorrow,
    updatedAt: Date.now(),
  };

  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      `📅 จองห้องนวด (${formatDateTH(
        tomorrow
      )})\n\n` +
      `กรุณาเลือกเวลา 👇`,
    quickReply: {
      items: freeSlots.map((slot) => ({
        type: "action",
        action: {
          type: "message",
          label: slot,
          text: `เลือกเวลา:${slot}`,
        },
      })),
    },
  });
}

// ============================================================
// BOOKING FLOW
// ============================================================

async function handleBookingFlow(
  event,
  userId,
  text
) {
  const state = pendingBooking[userId];

  // ==========================
  // choose time
  // ==========================

  if (state.step === "choose_time") {
    const match = text.match(
      /^เลือกเวลา:(\d{2}:\d{2})$/
    );

    if (!match) {
      return client.replyMessage(
        event.replyToken,
        {
          type: "text",
          text: "กรุณาเลือกเวลาจากปุ่มค่ะ 🙏",
        }
      );
    }

    const time = match[1];

    const available = getAvailableRooms(
      state.date,
      time
    );

    if (!available.length) {
      delete pendingBooking[userId];

      return client.replyMessage(
        event.replyToken,
        {
          type: "text",
          text: "❌ เวลานี้เต็มแล้วค่ะ",
        }
      );
    }

    pendingBooking[userId] = {
      ...state,
      step: "choose_room",
      time,
      updatedAt: Date.now(),
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `🛁 กรุณาเลือกห้อง 👇`,
      quickReply: {
        items: available.map((room) => ({
          type: "action",
          action: {
            type: "message",
            label: room,
            text: `เลือกห้อง:${room}`,
          },
        })),
      },
    });
  }

  // ==========================
  // choose room
  // ==========================

  if (state.step === "choose_room") {
    const match = text.match(/^เลือกห้อง:(.+)$/);

    if (!match) {
      return client.replyMessage(
        event.replyToken,
        {
          type: "text",
          text: "กรุณาเลือกห้องจากปุ่มค่ะ 🙏",
        }
      );
    }

    const room = match[1];

    pendingBooking[userId] = {
      ...state,
      room,
      step: "confirm",
      updatedAt: Date.now(),
    };

    return client.replyMessage(event.replyToken, {
      type: "template",
      altText: "ยืนยันการจอง",
      template: {
        type: "confirm",
        text:
          `📋 ยืนยันการจอง\n\n` +
          `📅 ${formatDateTH(state.date)}\n` +
          `⏰ ${state.time}\n` +
          `🛁 ${room}`,
        actions: [
          {
            type: "message",
            label: "✅ ยืนยัน",
            text: "ยืนยันการจอง",
          },
          {
            type: "message",
            label: "❌ ยกเลิก",
            text: "ยกเลิกขั้นตอนจอง",
          },
        ],
      },
    });
  }

  // ==========================
  // confirm
  // ==========================

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
      };

      delete pendingBooking[userId];

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `🎉 จองสำเร็จ!\n\n` +
          `🔖 ${bookingId}\n` +
          `📅 ${formatDateTH(state.date)}\n` +
          `⏰ ${state.time}\n` +
          `🛁 ${state.room}`,
      });
    }

    delete pendingBooking[userId];

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ ยกเลิกขั้นตอนการจองแล้วค่ะ",
    });
  }
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

async function handleMessage(event) {
  if (
    event.type !== "message" ||
    event.message.type !== "text"
  ) {
    return;
  }

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const lower = text.toLowerCase();

  // ==========================================================
  // SESSION TIMEOUT
  // ==========================================================

  if (pendingBooking[userId]) {
    const state = pendingBooking[userId];

    if (
      state.updatedAt &&
      Date.now() - state.updatedAt >
        10 * 60 * 1000
    ) {
      delete pendingBooking[userId];

      return client.replyMessage(
        event.replyToken,
        {
          type: "text",
          text:
            "⌛ ขั้นตอนการจองหมดเวลาแล้วค่ะ\n\nกรุณาเริ่มใหม่ 😊",
        }
      );
    }
  }

  // ==========================================================
  // BOOKING FLOW
  // ==========================================================

  if (pendingBooking[userId]) {

    // ออกจาก flow
    if (
      /(ยกเลิกขั้นตอนจอง|ออก|cancel|menu|เมนูหลัก)/i.test(
        lower
      )
    ) {
      delete pendingBooking[userId];

      return client.replyMessage(
        event.replyToken,
        {
          type: "text",
          text:
            "❌ ออกจากขั้นตอนการจองแล้วค่ะ",
        }
      );
    }

    // ถ้าพิมพ์เมนูอื่น
    if (
      /(walk.?in|ห้องว่าง|มีห้อง)/i.test(
        lower
      ) ||
      /(ดูการจอง|การจองของฉัน)/i.test(
        lower
      )
    ) {
      delete pendingBooking[userId];
    } else {

      const isValidInput =
        text.match(/^เลือกเวลา:\d{2}:\d{2}$/) ||
        text.match(/^เลือกห้อง:.+$/) ||
        text === "ยืนยันการจอง";

      if (!isValidInput) {

        delete pendingBooking[userId];

        return client.replyMessage(
          event.replyToken,
          {
            type: "text",
            text:
              "❌ ระบบยกเลิก flow เดิมแล้วค่ะ\nกรุณาเริ่มใหม่ 😊",
          }
        );
      }

      pendingBooking[userId].updatedAt =
        Date.now();

      return handleBookingFlow(
        event,
        userId,
        text
      );
    }
  }

  // ==========================================================
  // KEYWORDS
  // ==========================================================

  if (
    /(จอง|book|reserve)/i.test(lower)
  ) {
    return sendBookingStart(event, userId);
  }

  if (
    /(walk.?in|ห้องว่าง|มีห้อง)/i.test(
      lower
    )
  ) {
    return sendWalkInStatus(event);
  }

  if (
    /(ดูการจอง|การจองของฉัน)/i.test(
      lower
    )
  ) {
    return sendMyBookings(event, userId);
  }

  return sendMainMenu(event);
}

// ============================================================
// MY BOOKINGS
// ============================================================

async function sendMyBookings(event, userId) {
  const active =
    getUserActiveBookings(userId);

  if (!active.length) {
    return client.replyMessage(
      event.replyToken,
      {
        type: "text",
        text: "ยังไม่มีการจองค่ะ",
      }
    );
  }

  const textList = active
    .map(
      (b) =>
        `🔖 ${b.bookingId}\n` +
        `📅 ${formatDateTH(b.date)}\n` +
        `⏰ ${b.time}\n` +
        `🛁 ${b.room}`
    )
    .join("\n\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📋 การจองของคุณ\n\n${textList}`,
  });
}

// ============================================================
// WALK IN
// ============================================================

async function sendWalkInStatus(event) {
  const today = getTodayStr();

  const currentSlot =
    getCurrentTimeSlot();

  if (!currentSlot) {
    return client.replyMessage(
      event.replyToken,
      {
        type: "text",
        text:
          "⏰ ตอนนี้ยังไม่เปิดบริการค่ะ",
      }
    );
  }

  const available = getAvailableRooms(
    today,
    currentSlot
  );

  if (!available.length) {

    addToWaitlist(
      event.source.userId,
      today,
      currentSlot
    );

    return client.replyMessage(
      event.replyToken,
      {
        type: "text",
        text:
          `❌ เวลา ${currentSlot} เต็มแล้วค่ะ\n\n` +
          `ระบบเพิ่มเข้าคิวรอแจ้งเตือนแล้ว ✨`,
      }
    );
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      `✅ มีห้องว่าง\n\n` +
      `⏰ ${currentSlot}\n` +
      `${available.join("\n")}`,
  });
}

// ============================================================
// WEBHOOK
// ============================================================

app.post(
  "/webhook",
  line.middleware(config),
  (req, res) => {
    Promise.all(
      req.body.events.map(handleMessage)
    )
      .then(() =>
        res.json({ status: "ok" })
      )
      .catch((err) => {
        console.error(err);
        res.status(500).end();
      });
  }
);

app.get("/", (_, res) => {
  res.send(
    "LINE Bot Massage Booking FIXED ✅"
  );
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `🚀 Server running on port ${PORT}`
  );
});