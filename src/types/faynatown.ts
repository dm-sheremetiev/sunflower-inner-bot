export interface AddVisitorPassBody {
  visitor_name: string;
  id?: number;
  sex?: number;
  resident_id: string;
  time_visit: string;
  time_leave: string;
  phone?: string | null;
  purpose?: string;
  visitor_num?: number;
  complex_id: number;
}

export interface HikVisionStatus {
  ComplexId: number;
  ComplexName: string;
  HikvisionId: string;
  ServerNotAvailable?: boolean;
}

export interface PassHistoryQueryBody {
  HikVisionStatuses: HikVisionStatus[];
  PassType: number;
  Offset: number;
  Limit: number;
  Filter: unknown;
}

export interface PassHistoryItem {
  id: string;
  passType: number;
  status: number;
  complexId: number;
  complexName: string;
  residentId: string;
  hikvisionPassId: string;
  startTime: string;
  endTime: string;
  /** Перепустка пішохода (PassType 2) */
  visitorName?: string;
  visitorPhone?: string;
  barCode?: string;
  /** Перепустка авто (PassType 1) */
  plateNumber?: string;
  flatId?: string;
  flatLabel?: string;
  purpose?: string;
  comment?: string;
  createdByPhone: string;
  created_at?: string;
}

/** Тіло запиту додавання авто-перепустки */
export interface AddCarPassBody {
  plate_no: string;
  driver_info: string;
  resident_id: string;
  TimeYearStart: number;
  TimeMonthStart: number;
  TimeDayStart: number;
  TimeHourStart: number;
  TimeMinutesStart: number;
  TimeYearEnd: number;
  TimeMonthEnd: number;
  TimeDayEnd: number;
  TimeHourEnd: number;
  TimeMinutesEnd: number;
  TimeStart: string;
  TimeEnd: string;
  driver_phone: string;
  ComplexId: number;
}
