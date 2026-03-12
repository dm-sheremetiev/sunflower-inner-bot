import { BinotelCallDetails } from "../types/binotel.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

import "dotenv/config";
import { sendTelegramMessage } from "./telegram.service.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const faynaPhone = process.env?.FAYNA_PHONE_NUMBER || "9999";
const frenchPhone = process.env?.FRENCH_PHONE_NUMBER || "8888";
const sevenPhone = process.env?.SEVEN_PHONE_NUMBER || "7777";
const officePhone = process.env?.OFFICE_PHONE_NUMBER || "6666";

const faynaChannel = process.env?.SUNFLOWER_FAYNA_CALLS_CHANNEL || "9999";
const frenchChannel = process.env?.SUNFLOWER_FRENCH_CALLS_CHANNEL || "8888";
const sevenChannel = process.env?.SUNFLOWER_SEVEN_CALLS_CHANNEL || "7777";
const officeChannel = process.env?.SUNFLOWER_OFFICE_CALLS_CHANNEL || "6666";

export const handleCompletedCallAction = async (
  callDetails: BinotelCallDetails
) => {
  const {
    callType,
    billsec,
    externalNumber,
    disposition,
    customerDataFromOutside,
    pbxNumberData,
    startTime,
  } = callDetails;

  // 1. Проверка: входящий и пропущенный
  const isIncoming = callType === "0";
  const isMissed =
    billsec === "0" || disposition === "NO ANSWER" || disposition === "VM";

  const callTime = dayjs.unix(Number(startTime)).tz("Europe/Kyiv");
  const isWorkingTime = callTime.hour() >= 7 && callTime.hour() < 22;

  if (!isIncoming || !isMissed || !isWorkingTime) {
    return {
      status: "success",
    };
  }

  let branchName = "";

  switch (pbxNumberData?.number) {
    case officePhone:
      branchName = "office";
      break;
    case faynaPhone:
      branchName = "fayna";
      break;
    case frenchPhone:
      branchName = "french";
      break;

    case sevenPhone:
      branchName = "seven";
      break;
  }

  let message = `Пропущений дзвінок від <code>${externalNumber}</code>.`;

  if (customerDataFromOutside?.name?.length) {
    message += ` Ім'я: ${customerDataFromOutside.name}.`;
  }

  if (customerDataFromOutside?.linkToCrmUrl) {
    message += ` <a href="${customerDataFromOutside.linkToCrmUrl}">Посилання на клієнта у СРМ</a>`;
  }

  await sendCallMessageToAppropriateChannel(message, branchName);

  return {
    status: "success",
  };
};

const sendCallMessageToAppropriateChannel = async (
  message: string,
  branchName: string
) => {
  let chatId = "";

  switch (branchName) {
    case (branchName = "office"):
      chatId = officeChannel;

      break;
    case (branchName = "fayna"):
      chatId = faynaChannel;

      break;
    case (branchName = "french"):
      chatId = frenchChannel;

      break;

    case (branchName = "seven"):
      chatId = sevenChannel;

      break;
  }

  if (!chatId) {
    return;
  }

  await sendTelegramMessage(chatId, message, "HTML");
};
