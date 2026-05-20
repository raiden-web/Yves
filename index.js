// ============================================================
// LINE Bot - ระบบจองห้องนวด FINAL
// ============================================================

process.env.TZ = "Asia/Bangkok";

const express = require("express");
const line = require("@line/bot-sdk");
const cron = require("node-cron");

const app = express();

const config = {
  channelAccessToken:
    process.env.LINE_CHANNEL_ACCESS_TOKEN,

  channelSecret:
    process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// ============================================================
// CONFIG
// ============================================================

// ห้องทั้งหมด
const ROOMS = [
  "ห้อง AGAVE",
  "ห้อง LIFE PLANT",
  "ห้อง ENTADA",
  
];

// ห้องสำหรับ LPG (ห้องเดียว)
const LPG_ROOM = "ห้อง AGAVE";

// Capacity ต่อ slot: LPG = 1, อื่นๆ = 2
const COURSE_CAPACITY = {
  "Facial Treatments": 2,
  "Body Treatments":   2,
  "Waxing":            2,
  "LPG Treatments":    1,
};

const COURSES = Object.keys(COURSE_CAPACITY);

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
  
];

const REMIND_BEFORE_MIN = [60, 15];

// ============================================================
// DATA
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
  return new Date()
    .toISOString()
    .split("T")[0];
}

function getTomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

function nowTH() {
  return new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "Asia/Bangkok",
    })
  );
}

function formatDateTH(dateStr) {
  const [y, m, d] = dateStr.split("-");
  const months = [
    "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.",
    "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.",
    "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
  ];
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${parseInt(y) + 543}`;
}

// ============================================================
// CAPACITY / AVAILABILITY (ตาม course)
// ============================================================

/**
 * นับจำนวนการจองที่ active ใน slot นั้น สำหรับ course นั้น
 */
function getBookingCountForCourse(dateStr, timeSlot, course) {
  return Object.values(bookingList).filter(
    (b) =>
      b.date   === dateStr &&
      b.time   === timeSlot &&
      b.course === course  &&
      b.status === "active"
  ).length;
}

/**
 * ตรวจว่า course นี้ยังรับได้อีกไหมในช่วงเวลานั้น
 */
function isCourseAvailable(dateStr, timeSlot, course) {
  const cap     = COURSE_CAPACITY[course] || 1;
  const booked  = getBookingCountForCourse(dateStr, timeSlot, course);
  return booked < cap;
}

/**
 * คืนรายการ course ที่ยังว่างใน slot นั้น
 */
function getAvailableCourses(dateStr, timeSlot) {
  return COURSES.filter((c) => isCourseAvailable(dateStr, timeSlot, c));
}

/**
 * ช่วงเวลาที่ยังมี course ใดๆ ว่างอยู่
 */
function getAvailableSlots(dateStr) {
  return SLOTS.filter(
    (slot) => getAvailableCourses(dateStr, slot).length > 0
  );
}

/**
 * Assign ห้องอัตโนมัติ
 * - LPG → ห้อง A เสมอ (ถ้าว่าง)
 * - อื่นๆ → ห้องแรกที่ยังไม่ถูกจองใน slot นั้น
 */
function assignRoom(dateStr, timeSlot, course) {
  if (course === "LPG Treatments") {
    // ตรวจว่าห้อง A ถูกใช้งานใน slot นี้หรือยัง (ทุก course)
    const lpgUsed = Object.values(bookingList).some(
      (b) =>
        b.date   === dateStr   &&
        b.time   === timeSlot  &&
        b.room   === LPG_ROOM  &&
        b.status === "active"
    );
    return lpgUsed ? null : LPG_ROOM;
  }

  // คอร์สอื่นๆ: ใช้ห้องที่ไม่ได้ถูก occupy ใน slot นี้
  // (ห้อง A ถูก reserve ไว้ให้ LPG ถ้าวันนั้นยังไม่มีการจอง LPG ก็ใช้ได้)
  const occupiedRooms = Object.values(bookingList)
    .filter(
      (b) =>
        b.date   === dateStr  &&
        b.time   === timeSlot &&
        b.status === "active"
    )
    .map((b) => b.room);

  const freeRoom = ROOMS.find((r) => !occupiedRooms.includes(r));
  return freeRoom || null;
}

function getCurrentTimeSlot() {
  const now   = nowTH();
  const hhmm  = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  for (let i = SLOTS.length - 1; i >= 0; i--) {
    if (SLOTS[i] <= hhmm) return SLOTS[i];
  }
  return null;
}

// ============================================================
// WAITLIST
// ============================================================

function addToWaitlist(userId, dateStr, timeSlot) {
  const key = `${dateStr}|${timeSlot}`;
  if (!waitlist[key]) waitlist[key] = [];
  if (!waitlist[key].includes(userId)) waitlist[key].push(userId);
}

async function notifyWaitlist(dateStr, timeSlot) {
  const key   = `${dateStr}|${timeSlot}`;
  const users = waitlist[key] || [];
  if (!users.length) return;

  for (const uid of users) {
    try {
      await client.pushMessage(uid, {
        type: "text",
        text:
          `🔔 มีคิวว่างแล้วค่ะ\n\n` +
          `📅 ${formatDateTH(dateStr)}\n` +
          `⏰ ${timeSlot}\n\n` +
          `กรุณากดเมนูจองอีกครั้ง`,
      });
    } catch (e) {
      console.log(e.message);
    }
  }

  delete waitlist[key];
}

// ============================================================
// REMINDER
// ============================================================

cron.schedule("* * * * *", async () => {
  const now         = nowTH();
  const today       = now.toISOString().split("T")[0];
  const currentHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  for (const [id, b] of Object.entries(bookingList)) {
    if (b.status !== "active" || b.date !== today) continue;

    for (const minBefore of REMIND_BEFORE_MIN) {
      const remindKey = `r_${minBefore}`;
      if (b.remindedAt && b.remindedAt.has(remindKey)) continue;

      const [h, m] = b.time.split(":").map(Number);
      const total  = h * 60 + m - minBefore;
      const hhmm   = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

      if (hhmm === currentHHMM) {
        try {
          const msg =
            minBefore === 60
              ? `🔔 อีก 1 ชั่วโมงถึงเวลานวด\n\n⏰ ${b.time}\n💆 ${b.course}\n🛁 ${b.room}`
              : `⏰ อีก 15 นาทีถึงเวลานวด\n\n⏰ ${b.time}\n💆 ${b.course}\n🛁 ${b.room}`;

          await client.pushMessage(b.userId, { type: "text", text: msg });
          bookingList[id].remindedAt.add(remindKey);
        } catch (e) {
          console.log(e.message);
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
    type: "text",
    text: "🛁 ระบบจองห้องนวด",
    quickReply: {
      items: [
        {
          type: "action",
          action: { type: "message", label: "📅 จองล่วงหน้า", text: "จองห้องนวด" },
        },
        {
          type: "action",
          action: { type: "message", label: "🚶 Walk in", text: "walk in" },
        },
        {
          type: "action",
          action: { type: "message", label: "❌ ยกเลิกการจอง", text: "ยกเลิกการจอง" },
        },
      ],
    },
  });
}

// ============================================================
// WALK IN
// ============================================================

async function sendWalkInStatus(event) {
  const today       = getTodayStr();
  const currentSlot = getCurrentTimeSlot();

  if (!currentSlot) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "⏰ เปิดบริการ 10:00 - 20:00 น.",
    });
  }

  const available = getAvailableCourses(today, currentSlot);

  if (!available.length) {
    addToWaitlist(event.source.userId, today, currentSlot);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `❌ เวลา ${currentSlot} เต็มทุกคอร์สแล้ว\n\n` +
        `📩 หากมีการยกเลิก ระบบจะแจ้งเตือนอัตโนมัติ`,
    });
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      `✅ มีคิวว่าง\n\n` +
      `⏰ ${currentSlot}\n\n` +
      `💆 คอร์สที่ว่าง:\n` +
      available.map((c) => `• ${c}`).join("\n"),
  });
}

// ============================================================
// BOOKING START  (step แรก = เลือกคอร์ส)
// ============================================================

async function sendBookingStart(event, userId) {
  const tomorrow   = getTomorrowStr();
  const freeSlots  = getAvailableSlots(tomorrow);

  if (!freeSlots.length) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ วันพรุ่งนี้เต็มทุกคอร์สแล้วค่ะ",
    });
  }

  // ขั้นแรก: เลือกคอร์ส
  pendingBooking[userId] = {
    step: "choose_course",
    date: tomorrow,
  };

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📅 ${formatDateTH(tomorrow)}\n\n💆 กรุณาเลือกคอร์สที่ต้องการ`,
    quickReply: {
      items: COURSES.map((course) => ({
        type: "action",
        action: {
          type:  "message",
          label: course,
          text:  `เลือกคอร์ส:${course}`,
        },
      })),
    },
  });
}

// ============================================================
// BOOKING FLOW
// ============================================================

async function handleBookingFlow(event, userId, text) {
  const state = pendingBooking[userId];

  // ==========================================================
  // STEP 1: CHOOSE COURSE
  // ==========================================================

  if (state.step === "choose_course") {
    const match = text.match(/^เลือกคอร์ส:(.+)$/);
    if (!match) return;

    const course = match[1];

    if (!COURSE_CAPACITY[course]) return;

    // แสดง slot ที่ว่างสำหรับ course นี้
    const freeSlots = SLOTS.filter((slot) =>
      isCourseAvailable(state.date, slot, course)
    );

    if (!freeSlots.length) {
      delete pendingBooking[userId];
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `❌ คอร์ส ${course} เต็มทุกช่วงเวลาแล้วค่ะ`,
      });
    }

    pendingBooking[userId] = {
      ...state,
      step:   "choose_time",
      course,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `💆 ${course}\n\n⏰ กรุณาเลือกเวลา\n${formatDateTH(state.date)}`,
      quickReply: {
        items: freeSlots.map((slot) => ({
          type: "action",
          action: {
            type:  "message",
            label: slot,
            text:  `เลือกเวลา:${slot}`,
          },
        })),
      },
    });
  }

  // ==========================================================
  // STEP 2: CHOOSE TIME
  // ==========================================================

  if (state.step === "choose_time") {
    const match = text.match(/^เลือกเวลา:(\d{2}:\d{2})$/);
    if (!match) return;

    const time = match[1];

    // ตรวจอีกครั้งว่ายังว่างอยู่
    if (!isCourseAvailable(state.date, time, state.course)) {
      delete pendingBooking[userId];
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ เวลานี้เต็มแล้ว กรุณาจองใหม่",
      });
    }

    // Assign ห้องอัตโนมัติ
    const room = assignRoom(state.date, time, state.course);

    if (!room) {
      delete pendingBooking[userId];
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ ไม่มีห้องว่างในช่วงเวลานี้ กรุณาจองใหม่",
      });
    }

    pendingBooking[userId] = {
      ...state,
      step: "confirm",
      time,
      room,
    };

    return client.replyMessage(event.replyToken, {
      type:    "template",
      altText: "ยืนยันการจอง",
      template: {
        type: "confirm",
        text:
          `📋 ยืนยันการจอง\n\n` +
          `📅 ${formatDateTH(state.date)}\n` +
          `⏰ ${time}\n` +
          `💆 ${state.course}\n` +
          `🛁 ${room}`,
        actions: [
          { type: "message", label: "✅ ยืนยัน", text: "ยืนยันการจอง" },
          { type: "message", label: "❌ ยกเลิก", text: "ยกเลิกขั้นตอนจอง" },
        ],
      },
    });
  }

  // ==========================================================
  // STEP 3: CONFIRM
  // ==========================================================

  if (state.step === "confirm") {
    if (text !== "ยืนยันการจอง") {
      delete pendingBooking[userId];
      return;
    }

    // ตรวจสอบอีกครั้งก่อน save
    if (!isCourseAvailable(state.date, state.time, state.course)) {
      delete pendingBooking[userId];
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ เสียใจด้วย มีคนจองเต็มแล้ว กรุณาจองใหม่ค่ะ",
      });
    }

    const room = assignRoom(state.date, state.time, state.course);

    if (!room) {
      delete pendingBooking[userId];
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ ไม่มีห้องว่าง กรุณาจองใหม่ค่ะ",
      });
    }

    const bookingId = genBookingId();

    bookingList[bookingId] = {
      userId,
      date:      state.date,
      time:      state.time,
      course:    state.course,
      room,
      status:    "active",
      remindedAt: new Set(),
    };

    delete pendingBooking[userId];

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `🎉 จองสำเร็จ\n\n` +
        `🔖 ${bookingId}\n` +
        `📅 ${formatDateTH(state.date)}\n` +
        `⏰ ${state.time}\n` +
        `💆 ${state.course}\n` +
        `🛁 ${room}\n\n` +
        `🔔 มีแจ้งเตือนก่อนนัด`,
    });
  }
}

// ============================================================
// CANCEL FLOW
// ============================================================

async function startCancelFlow(event, userId) {
  const activeBookings = Object.entries(bookingList).filter(
    ([, b]) => b.userId === userId && b.status === "active"
  );

  if (!activeBookings.length) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ ไม่พบรายการจอง",
    });
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "📋 เลือกรายการที่ต้องการยกเลิก",
    quickReply: {
      items: activeBookings.map(([id, b]) => ({
        type: "action",
        action: {
          type:  "message",
          label: `${b.time} ${b.course.replace(" Treatments", "")}`.slice(0, 20),
          text:  `ยกเลิก:${id}`,
        },
      })),
    },
  });
}

async function confirmCancelBooking(event, userId, bookingId) {
  const booking = bookingList[bookingId];

  if (!booking || booking.userId !== userId) return;

  pendingCancel[userId] = { bookingId };

  return client.replyMessage(event.replyToken, {
    type:    "template",
    altText: "ยืนยันยกเลิก",
    template: {
      type: "confirm",
      text:
        `⚠️ ยืนยันยกเลิก?\n\n` +
        `📅 ${formatDateTH(booking.date)}\n` +
        `⏰ ${booking.time}\n` +
        `💆 ${booking.course}\n` +
        `🛁 ${booking.room}`,
      actions: [
        { type: "message", label: "✅ ยืนยัน", text: "ยืนยันยกเลิก" },
        { type: "message", label: "❌ ไม่ยกเลิก", text: "ไม่ยกเลิก" },
      ],
    },
  });
}

async function executeCancelBooking(event, userId) {
  const state = pendingCancel[userId];
  if (!state) return;

  const booking = bookingList[state.bookingId];

  if (!booking) {
    delete pendingCancel[userId];
    return;
  }

  booking.status = "cancelled";
  delete pendingCancel[userId];

  await notifyWaitlist(booking.date, booking.time);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      `✅ ยกเลิกการจองสำเร็จ\n\n` +
      `📅 ${formatDateTH(booking.date)}\n` +
      `⏰ ${booking.time}\n` +
      `💆 ${booking.course}\n` +
      `🛁 ${booking.room}`,
  });
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

async function handleMessage(event) {
  if (
    event.type !== "message" ||
    event.message.type !== "text"
  ) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "🤖 นี่เป็นระบบ BOT สำหรับจองเวลาเท่านั้น\n\nหากต้องการสอบถามเพิ่มเติม กรุณาติดต่อทาง LINE Official Account ค่ะ 🙏",
    });
  }

  const userId = event.source.userId;
  const text   = event.message.text.trim();
  const lower  = text.toLowerCase();

  // ==========================================================
  // CANCEL CONFIRM
  // ==========================================================

  if (pendingCancel[userId]) {
    if (text === "ยืนยันยกเลิก") return executeCancelBooking(event, userId);
    if (text === "ไม่ยกเลิก") {
      delete pendingCancel[userId];
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "↩️ ยกเลิกคำสั่งแล้วค่ะ",
      });
    }
    return;
  }

  // ==========================================================
  // SELECT CANCEL
  // ==========================================================

  const cancelMatch = text.match(/^ยกเลิก:(BK\d+)$/);
  if (cancelMatch) {
    return confirmCancelBooking(event, userId, cancelMatch[1]);
  }

  // ==========================================================
  // BOOKING FLOW
  // ==========================================================

  if (pendingBooking[userId]) {
    if (text === "ยกเลิกขั้นตอนจอง") {
      delete pendingBooking[userId];
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "↩️ ยกเลิกขั้นตอนการจองแล้วค่ะ",
      });
    }
    return handleBookingFlow(event, userId, text);
  }

  // ==========================================================
  // KEYWORDS
  // ==========================================================

  if (/(ยกเลิกการจอง|ยกเลิก)/i.test(lower)) {
    return startCancelFlow(event, userId);
  }

  if (/(จอง|book|reserve)/i.test(lower) && !/(ยกเลิก)/i.test(lower)) {
    return sendBookingStart(event, userId);
  }

  if (/(walk.?in|ห้องว่าง|มีห้อง)/i.test(lower)) {
    return sendWalkInStatus(event);
  }

  return;
}

// ============================================================
// WEBHOOK
// ============================================================

app.post(
  "/webhook",
  line.middleware(config),
  (req, res) => {
    Promise.all(req.body.events.map(handleMessage))
      .then(() => res.json({ status: "ok" }))
      .catch((err) => {
        console.log(err);
        res.status(500).end();
      });
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (_, res) => {
  res.send("LINE BOT RUNNING ✅");
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});