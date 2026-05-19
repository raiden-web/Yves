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
          label: "❌ ยกเลิกการจอง",
          text: "ยกเลิกการจอง",
        },
      ],
    },
  });
}

// ============================================================
// CANCEL BOOKING FLOW
// ============================================================

async function startCancelFlow(event, userId) {

  const active = getUserActiveBookings(userId);

  if (!active.length) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "❌ คุณยังไม่มีรายการจองค่ะ",
    });
  }

  const quickItems = active.map((b) => ({
    type: "action",
    action: {
      type: "message",
      label: `${b.time} ${b.room}`,
      text: `ยกเลิก:${b.bookingId}`,
    },
  }));

  const bookingText = active
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
    text:
      `📋 รายการจองของคุณ\n\n` +
      `${bookingText}\n\n` +
      `กรุณาเลือกรายการที่ต้องการยกเลิก 👇`,

    quickReply: {
      items: quickItems,
    },
  });
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
    booking.userId !== userId ||
    booking.status !== "active"
  ) {
    return client.replyMessage(
      event.replyToken,
      {
        type: "text",
        text:
          "❌ ไม่พบรายการจองค่ะ",
      }
    );
  }

  pendingCancel[userId] = {
    bookingId,
  };

  return client.replyMessage(event.replyToken, {
    type: "template",
    altText: "ยืนยันยกเลิกการจอง",
    template: {
      type: "confirm",

      text:
        `⚠️ ยืนยันยกเลิกการจอง?\n\n` +
        `📅 ${formatDateTH(
          booking.date
        )}\n` +
        `⏰ ${booking.time}\n` +
        `🛁 ${booking.room}`,

      actions: [
        {
          type: "message",
          label: "✅ ยืนยัน",
          text: "ยืนยันยกเลิกจอง",
        },
        {
          type: "message",
          label: "❌ ไม่ยกเลิก",
          text: "ไม่ยกเลิก",
        },
      ],
    },
  });
}

async function executeCancelBooking(
  event,
  userId
) {

  const state =
    pendingCancel[userId];

  if (!state) return;

  const booking =
    bookingList[state.bookingId];

  delete pendingCancel[userId];

  if (
    !booking ||
    booking.status !== "active"
  ) {
    return client.replyMessage(
      event.replyToken,
      {
        type: "text",
        text:
          "❌ ไม่พบรายการจองค่ะ",
      }
    );
  }

  booking.status = "cancelled";

  await client.replyMessage(event.replyToken, {
    type: "text",
    text:
      `✅ ยกเลิกการจองเรียบร้อยแล้ว\n\n` +
      `📅 ${formatDateTH(
        booking.date
      )}\n` +
      `⏰ ${booking.time}\n` +
      `🛁 ${booking.room}\n\n` +
      `ขอบคุณที่แจ้งล่วงหน้าค่ะ 🙏`,
  });

  // แจ้งคนรอคิว
  await notifyWaitlist(
    booking.date,
    booking.time
  );
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

  const text =
    event.message.text.trim();

  const lower =
    text.toLowerCase();

  // ==========================================================
  // CANCEL FLOW
  // ==========================================================

  if (pendingCancel[userId]) {

    if (
      text === "ยืนยันยกเลิกจอง"
    ) {
      return executeCancelBooking(
        event,
        userId
      );
    }

    if (text === "ไม่ยกเลิก") {

      delete pendingCancel[userId];

      return client.replyMessage(
        event.replyToken,
        {
          type: "text",
          text:
            "😊 ระบบยังคงการจองเดิมไว้ค่ะ",
        }
      );
    }
  }

  // ==========================================================
  // BOOKING FLOW
  // ==========================================================

  if (pendingBooking[userId]) {

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

    const isValidInput =
      text.match(
        /^เลือกเวลา:\d{2}:\d{2}$/
      ) ||
      text.match(/^เลือกห้อง:.+$/) ||
      text === "ยืนยันการจอง";

    if (!isValidInput) {

      delete pendingBooking[userId];

      return client.replyMessage(
        event.replyToken,
        {
          type: "text",
          text:
            "❌ ระบบยกเลิกขั้นตอนเดิมแล้วค่ะ\nกรุณาเริ่มใหม่ 😊",
        }
      );
    }

    pendingBooking[userId]
      .updatedAt = Date.now();

    return handleBookingFlow(
      event,
      userId,
      text
    );
  }

  // ==========================================================
  // CANCEL SELECT
  // ==========================================================

  const cancelMatch =
    text.match(/^ยกเลิก:(BK\d+)$/);

  if (cancelMatch) {
    return confirmCancelBooking(
      event,
      userId,
      cancelMatch[1]
    );
  }

  // ==========================================================
  // KEYWORDS
  // ==========================================================

  if (
    /(ยกเลิกการจอง)/i.test(lower)
  ) {
    return startCancelFlow(
      event,
      userId
    );
  }

  if (
    /(จอง|book|reserve)/i.test(
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
    return sendWalkInStatus(event);
  }

  return sendMainMenu(event);
}