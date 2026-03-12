export interface CallCompletedBody {
  requestType: "apiCallCompleted";
  attemptsCounter: string; // приходит как строка
  language: string;
  myBinotelDomain: string;
  callDetails: BinotelCallDetails;
}

export interface BinotelCallDetails {
  companyID: string;
  generalCallID: string;
  callID: string;
  startTime: string; // UNIX timestamp
  callType: "0" | "1"; // 0 - входящий, 1 - исходящий
  internalNumber: string;
  internalAdditionalData: string;
  externalNumber: string;
  waitsec: string;
  billsec: string;
  disposition: string;
  recordingStatus: string;
  isNewCall: "0" | "1";
  whoHungUp: string;

  customerData?: {
    id: string;
    name: string;
  };

  pbxNumberData?: {
    number: string;
  };

  historyData?: HistoryData[];

  customerDataFromOutside?: {
    id: string;
    externalNumber: string;
    name: string;
    linkToCrmUrl: string;
  };

  linkToCallRecordOverlayInMyBusiness: string;
  linkToCallRecordInMyBusiness: string;
}

export interface HistoryData {
  waitsec: string;
  billsec: string;
  disposition: string;
  internalNumber: string;
  internalAdditionalData: string;
}
