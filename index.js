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

const ROOMS = [
  "ห้อง A",
  "ห้อง B",
  "ห้อง C",
  "ห้อง D",
];

const COURSES = [
  "Facial Treatments",
  "Hair Treatments",
  "Body Treatments",
  "Waxing",
  "LPG Treatments",
];

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

  return d
    .toISOString()
    .split("T")[0];
}

function nowTH() {

  return new Date(
    new Date().toLocaleString(
      "en-US",
      {
        timeZone: "Asia/Bangkok",
      }
    )
  );
}

function formatDateTH(dateStr) {

  const [y, m, d] =
    dateStr.split("-");

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

  return `${parseInt(d)} ${
    months[parseInt(m) - 1]
  } ${parseInt(y) + 543}`;
}

function getBookedRooms(
  dateStr,
  timeSlot
) {

  return Object.values(bookingList)
    .filter(
      (b) =>
        b.date === dateStr &&
        b.time === timeSlot &&
        b.status === "active"
    )
    .map((b) => b.room);
}

function getAvailableRooms(
  dateStr,
  timeSlot
) {

  const booked =
    getBookedRooms(
      dateStr,
      timeSlot
    );

  return ROOMS.filter(
    (r) => !booked.includes(r)
  );
}

function getAvailableSlots(
  dateStr
) {

  return SLOTS.filter(
    (slot) =>
      getAvailableRooms(
        dateStr,
        slot
      ).length > 0
  );
}

function getCurrentTimeSlot() {

  const now = nowTH();

  const hhmm = `${String(
    now.getHours()
  ).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;

  for (
    let i = SLOTS.length - 1;
    i >= 0;
    i--
  ) {

    if (SLOTS[i] <= hhmm) {
      return SLOTS[i];
    }
  }

  return null;
}

// ============================================================
// WAITLIST
// ============================================================

function addToWaitlist(
  userId,
  dateStr,
  timeSlot
) {

  const key =
    `${dateStr}|${timeSlot}`;

  if (!waitlist[key]) {
    waitlist[key] = [];
  }

  if (
    !waitlist[key].includes(
      userId
    )
  ) {

    waitlist[key].push(userId);
  }
}

async function notifyWaitlist(
  dateStr,
  timeSlot
) {

  const key =
    `${dateStr}|${timeSlot}`;

  const users =
    waitlist[key] || [];

  if (!users.length) return;

  for (const uid of users) {

    try {

      await client.pushMessage(
        uid,
        {
          type: "text",

          text:
            `🔔 มีห้องว่างแล้วค่ะ\n\n` +
            `📅 ${formatDateTH(
              dateStr
            )}\n` +
            `⏰ ${timeSlot}\n\n` +
            `กรุณากดเมนูจองอีกครั้ง`,
        }
      );

    } catch (e) {
      console.log(e.message);
    }
  }

  delete waitlist[key];
}

// ============================================================
// REMINDER
// ============================================================

cron.schedule(
  "* * * * *",
  async () => {

    const now = nowTH();

    const today =
      now
        .toISOString()
        .split("T")[0];

    const currentHHMM =
      `${String(
        now.getHours()
      ).padStart(2, "0")}:${String(
        now.getMinutes()
      ).padStart(2, "0")}`;

    for (const [id, b]
      of Object.entries(
        bookingList
      )) {

      if (
        b.status !== "active" ||
        b.date !== today
      ) {
        continue;
      }

      for (const minBefore
        of REMIND_BEFORE_MIN) {

        const remindKey =
          `r_${minBefore}`;

        if (
          b.remindedAt &&
          b.remindedAt.has(
            remindKey
          )
        ) {
          continue;
        }

        const [h, m] =
          b.time
            .split(":")
            .map(Number);

        const total =
          h * 60 +
          m -
          minBefore;

        const hhmm =
          `${String(
            Math.floor(
              total / 60
            )
          ).padStart(
            2,
            "0"
          )}:${String(
            total % 60
          ).padStart(2, "0")}`;

        if (
          hhmm === currentHHMM
        ) {

          try {

            const msg =
              minBefore === 60
                ? `🔔 อีก 1 ชั่วโมงถึงเวลานวด\n\n⏰ ${b.time}\n💆 ${b.course}\n🛁 ${b.room}`
                : `⏰ อีก 15 นาทีถึงเวลานวด\n\n⏰ ${b.time}\n💆 ${b.course}\n🛁 ${b.room}`;

            await client.pushMessage(
              b.userId,
              {
                type: "text",
                text: msg,
              }
            );

            bookingList[
              id
            ].remindedAt.add(
              remindKey
            );

          } catch (e) {
            console.log(
              e.message
            );
          }
        }
      }
    }
  }
);

// ============================================================
// MAIN MENU
// ============================================================

async function sendMainMenu(
  event
) {

  return client.replyMessage(
    event.replyToken,
    {
      type: "text",

      text:
        "🛁 ระบบจองห้องนวด",

      quickReply: {
        items: [

          {
            type: "action",

            action: {
              type: "message",
              label:
                "📅 จองล่วงหน้า",
              text:
                "จองห้องนวด",
            },
          },

          {
            type: "action",

            action: {
              type: "message",
              label:
                "🚶 Walk in",
              text:
                "walk in",
            },
          },

          {
            type: "action",

            action: {
              type: "message",
              label:
                "❌ ยกเลิกการจอง",
              text:
                "ยกเลิกการจอง",
            },
          },
        ],
      },
    }
  );
}

// ============================================================
// WALK IN
// ============================================================

async function sendWalkInStatus(
  event
) {

  const today =
    getTodayStr();

  const currentSlot =
    getCurrentTimeSlot();

  if (!currentSlot) {

    return client.replyMessage(
      event.replyToken,
      {
        type: "text",

        text:
          "⏰ เปิดบริการ 10:00 - 20:00 น.",
      }
    );
  }

  const available =
    getAvailableRooms(
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
          `❌ เวลา ${currentSlot} เต็มแล้ว\n\n` +
          `📩 หากมีการยกเลิก ระบบจะแจ้งเตือนอัตโนมัติ`,
      }
    );
  }

  return client.replyMessage(
    event.replyToken,
    {
      type: "text",

      text:
        `✅ มีห้องว่าง\n\n` +
        `⏰ ${currentSlot}\n\n` +
        available
          .map(
            (r) => `• ${r}`
          )
          .join("\n"),
    }
  );
}

// ============================================================
// BOOKING START
// ============================================================

async function sendBookingStart(
  event,
  userId
) {

  const tomorrow =
    getTomorrowStr();

  const freeSlots =
    getAvailableSlots(
      tomorrow
    );

  if (!freeSlots.length) {

    return client.replyMessage(
      event.replyToken,
      {
        type: "text",

        text:
          "❌ วันพรุ่งนี้เต็มแล้วค่ะ",
      }
    );
  }

  pendingBooking[userId] = {
    step: "choose_time",
    date: tomorrow,
  };

  return client.replyMessage(
    event.replyToken,
    {
      type: "text",

      text:
        `📅 เลือกเวลาที่ต้องการ\n` +
        `${formatDateTH(
          tomorrow
        )}`,

      quickReply: {
        items: freeSlots.map(
          (slot) => ({
            type: "action",

            action: {
              type: "message",
              label: slot,
              text:
                `เลือกเวลา:${slot}`,
            },
          })
        ),
      },
    }
  );
}

// ============================================================
// BOOKING FLOW
// ============================================================

async function handleBookingFlow(
  event,
  userId,
  text
) {

  const state =
    pendingBooking[userId];

  // ==========================================================
  // CHOOSE TIME
  // ==========================================================

  if (
    state.step ===
    "choose_time"
  ) {

    const match =
      text.match(
        /^เลือกเวลา:(\d{2}:\d{2})$/
      );

    if (!match) {
      return;
    }

    const time = match[1];

    pendingBooking[userId] = {
      ...state,
      step:
        "choose_course",
      time,
    };

    return client.replyMessage(
      event.replyToken,
      {
        type: "text",

        text:
          `⏰ ${time}\n\n` +
          `💆 กรุณาเลือกคอร์ส`,

        quickReply: {
          items: COURSES.map(
            (course) => ({
              type:
                "action",

              action: {
                type:
                  "message",

                label:
                  course,

                text:
                  `เลือกคอร์ส:${course}`,
              },
            })
          ),
        },
      }
    );
  }

  // ==========================================================
  // CHOOSE COURSE
  // ==========================================================

  if (
    state.step ===
    "choose_course"
  ) {

    const match =
      text.match(
        /^เลือกคอร์ส:(.+)$/
      );

    if (!match) {
      return;
    }

    const course =
      match[1];

    const available =
      getAvailableRooms(
        state.date,
        state.time
      );

    if (!available.length) {

      delete pendingBooking[
        userId
      ];

      return client.replyMessage(
        event.replyToken,
        {
          type: "text",

          text:
            "❌ เวลานี้เต็มแล้ว กรุณาจองใหม่",
        }
      );
    }

    pendingBooking[userId] = {
      ...state,
      step:
        "choose_room",
      course,
    };

    return client.replyMessage(
      event.replyToken,
      {
        type: "text",

        text:
          `💆 ${course}\n\n` +
          `🛁 กรุณาเลือกห้อง`,

        quickReply: {
          items:
            available.map(
              (room) => ({
                type:
                  "action",

                action: {
                  type:
                    "message",

                  label:
                    room,

                  text:
                    `เลือกห้อง:${room}`,
                },
              })
            ),
        },
      }
    );
  }

  // ==========================================================
  // CHOOSE ROOM
  // ==========================================================

  if (
    state.step ===
    "choose_room"
  ) {

    const match =
      text.match(
        /^เลือกห้อง:(.+)$/
      );

    if (!match) {
      return;
    }

    const room =
      match[1];

    pendingBooking[userId] = {
      ...state,
      step: "confirm",
      room,
    };

    return client.replyMessage(
      event.replyToken,
      {
        type:
          "template",

        altText:
          "ยืนยันการจอง",

        template: {
          type:
            "confirm",

          text:
            `📋 ยืนยันการจอง\n\n` +
            `📅 ${formatDateTH(
              state.date
            )}\n` +
            `⏰ ${state.time}\n` +
            `💆 ${state.course}\n` +
            `🛁 ${room}`,

          actions: [

            {
              type:
                "message",

              label:
                "✅ ยืนยัน",

              text:
                "ยืนยันการจอง",
            },

            {
              type:
                "message",

              label:
                "❌ ยกเลิก",

              text:
                "ยกเลิกขั้นตอนจอง",
            },
          ],
        },
      }
    );
  }

  // ==========================================================
  // CONFIRM
  // ==========================================================

  if (
    state.step ===
    "confirm"
  ) {

    if (
      text !==
      "ยืนยันการจอง"
    ) {

      delete pendingBooking[
        userId
      ];

      return;
    }

    const bookingId =
      genBookingId();

    bookingList[bookingId] = {
      userId,
      date: state.date,
      time: state.time,
      course:
        state.course,
      room: state.room,
      status:
        "active",
      remindedAt:
        new Set(),
    };

    delete pendingBooking[
      userId
    ];

    return client.replyMessage(
      event.replyToken,
      {
        type: "text",

        text:
          `🎉 จองสำเร็จ\n\n` +
          `🔖 ${bookingId}\n` +
          `📅 ${formatDateTH(
            state.date
          )}\n` +
          `⏰ ${state.time}\n` +
          `💆 ${state.course}\n` +
          `🛁 ${state.room}\n\n` +
          `🔔 มีแจ้งเตือนก่อนนัด`,
      }
    );
  }
}

// ============================================================
// CANCEL FLOW
// ============================================================

async function startCancelFlow(
  event,
  userId
) {

  const activeBookings =
    Object.entries(
      bookingList
    ).filter(
      ([, b]) =>
        b.userId ===
          userId &&
        b.status ===
          "active"
    );

  if (
    !activeBookings.length
  ) {

    return client.replyMessage(
      event.replyToken,
      {
        type: "text",

        text:
          "❌ ไม่พบรายการจอง",
      }
    );
  }

  return client.replyMessage(
    event.replyToken,
    {
      type: "text",

      text:
        "📋 เลือกรายการที่ต้องการยกเลิก",

      quickReply: {
        items:
          activeBookings.map(
            ([id, b]) => ({
              type:
                "action",

              action: {
                type:
                  "message",

                label:
                  `${b.time} ${b.room}`,

                text:
                  `ยกเลิก:${id}`,
              },
            })
          ),
      },
    }
  );
}

async function confirmCancelBooking(
  event,
  userId,
  bookingId
) {

  const booking =
    bookingList[bookingId];

  if (
    !booking ||
    booking.userId !==
      userId
  ) {

    return;
  }

  pendingCancel[userId] = {
    bookingId,
  };

  return client.replyMessage(
    event.replyToken,
    {
      type:
        "template",

      altText:
        "ยืนยันยกเลิก",

      template: {
        type:
          "confirm",

        text:
          `⚠️ ยืนยันยกเลิก?\n\n` +
          `📅 ${formatDateTH(
            booking.date
          )}\n` +
          `⏰ ${booking.time}\n` +
          `💆 ${booking.course}\n` +
          `🛁 ${booking.room}`,

        actions: [

          {
            type:
              "message",

            label:
              "✅ ยืนยัน",

            text:
              "ยืนยันยกเลิก",
          },

          {
            type:
              "message",

            label:
              "❌ ไม่ยกเลิก",

            text:
              "ไม่ยกเลิก",
          },
        ],
      },
    }
  );
}

async function executeCancelBooking(
  event,
  userId
) {

  const state =
    pendingCancel[userId];

  if (!state) return;

  const booking =
    bookingList[
      state.bookingId
    ];

  if (!booking) {

    delete pendingCancel[
      userId
    ];

    return;
  }

  booking.status =
    "cancelled";

  delete pendingCancel[
    userId
  ];

  await notifyWaitlist(
    booking.date,
    booking.time
  );

  return client.replyMessage(
    event.replyToken,
    {
      type: "text",

      text:
        `✅ ยกเลิกการจองสำเร็จ\n\n` +
        `📅 ${formatDateTH(
          booking.date
        )}\n` +
        `⏰ ${booking.time}\n` +
        `💆 ${booking.course}\n` +
        `🛁 ${booking.room}`,
    }
  );
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

async function handleMessage(
  event
) {

  if (
    event.type !==
      "message" ||
    event.message.type !==
      "text"
  ) {
    return client.replyMessage(
  event.replyToken,
  {
    type: "text",

    text:
      "🤖 นี่เป็นระบบ BOT สำหรับจองเวลาเท่านั้น\n\nหากต้องการสอบถามเพิ่มเติม กรุณาติดต่อทาง LINE Official Account ค่ะ 🙏",
  }
);
  }

  const userId =
    event.source.userId;

  const text =
    event.message.text.trim();

  const lower =
    text.toLowerCase();

  // ==========================================================
  // CANCEL CONFIRM
  // ==========================================================

  if (
    pendingCancel[userId]
  ) {

    if (
      text ===
      "ยืนยันยกเลิก"
    ) {

      return executeCancelBooking(
        event,
        userId
      );
    }

    if (
      text ===
      "ไม่ยกเลิก"
    ) {

      delete pendingCancel[
        userId
      ];

      return;
    }

    return;
  }

  // ==========================================================
  // SELECT CANCEL
  // ==========================================================

  const cancelMatch =
    text.match(
      /^ยกเลิก:(BK\d+)$/
    );

  if (cancelMatch) {

    return confirmCancelBooking(
      event,
      userId,
      cancelMatch[1]
    );
  }

  // ==========================================================
  // BOOKING FLOW
  // ==========================================================

  if (
    pendingBooking[userId]
  ) {

    if (
      /(ยกเลิกการจอง)/i.test(
        text
      )
    ) {

      delete pendingBooking[
        userId
      ];

      return startCancelFlow(
        event,
        userId
      );
    }

    if (
      text ===
      "ยกเลิกขั้นตอนจอง"
    ) {

      delete pendingBooking[
        userId
      ];

      return;
    }

    return handleBookingFlow(
      event,
      userId,
      text
    );
  }

  // ==========================================================
  // KEYWORDS
  // ==========================================================

  if (
    /(ยกเลิกการจอง|ยกเลิก)/i.test(
      lower
    )
  ) {

    return startCancelFlow(
      event,
      userId
    );
  }

  if (
    /(จอง|book|reserve)/i.test(
      lower
    ) &&
    !/(ยกเลิก)/i.test(
      lower
    )
  ) {

    return sendBookingStart(
      event,
      userId
    );
  }

  if (
    /(walk.?in|ห้องว่าง|มีห้อง)/i.test(
      lower
    )
  ) {

    return sendWalkInStatus(
      event
    );
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

    Promise.all(
      req.body.events.map(
        handleMessage
      )
    )
      .then(() =>
        res.json({
          status: "ok",
        })
      )
      .catch((err) => {

        console.log(err);

        res
          .status(500)
          .end();
      });
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (_, res) => {

  res.send(
    "LINE BOT RUNNING ✅"
  );
});

// ============================================================
// START SERVER
// ============================================================

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `🚀 Server running on port ${PORT}`
  );
});