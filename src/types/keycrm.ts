/* eslint-disable @typescript-eslint/no-explicit-any */
// "order.change_order_status" //  зміна статусу замовлення
// "order.change_payment_status" // зміна статусу оплати замовлення
// "lead.change_lead_status" // зміна статусу картки воронки

export type KeyCrmEvent =
  | "order.change_order_status"
  | "order.change_payment_status"
  | "lead.change_lead_status";

export interface ChangeOrderContext {
  id: number;
  source_uuid: string | null;
  global_source_uuid: string | null;
  status_on_source: string | null;
  source_id: number;
  client_id: number;
  grand_total: number;
  total_discount: number;
  margin_sum: number;
  expenses_sum: number;
  discount_amount: number;
  discount_percent: number;
  shipping_price: string;
  taxes: string;
  register_id: string | null;
  fiscal_result: unknown[];
  fiscal_status: string;
  shipping_type_id: number | null;
  manager_id: number;
  status_group_id: number;
  status_id: number;
  closed_from: string | null;
  status_changed_at: string;
  status_expired_at: string | null;
  parent_id: number | null;
  manager_comment: string | null;
  client_comment: string | null;
  discount_data: {
    loyalty: {
      name: string;
      amount: number;
      discount: number;
      level_id: number;
      loyalty_program_id: number;
    };
    individual: {
      discount: number;
    };
  };
  is_gift: boolean;
  promocode: string;
  wrap_price: string;
  gift_wrap: boolean;
  payment_status: string;
  gift_message: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string;
  deleted_at: string | null;
  ordered_at: string;
  source_updated_at: string | null;
  payments_total: number;
  is_expired: boolean;
  has_reserves: boolean;
}

export interface ChangeOrderEvent {
  event: KeyCrmEvent;
  context: ChangeOrderContext;
}

export interface Order {
  id: number;
  parent_id: number;
  source_uuid: string;
  source_id: number;
  status_id: number;
  status_group_id: number;
  grand_total: number;
  promocode: string;
  total_discount: number;
  discount_amount?: number;
  discount_percent?: number;
  discount_data?: {
    loyalty?: {
      name?: string;
      discount?: number;
    };
  };
  expenses_sum: number;
  shipping_price: number;
  wrap_price: number;
  taxes: number;
  manager_comment: string | null;
  buyer_comment: string;
  gift_message: string;
  is_gift: boolean;
  payment_status: string;
  last_synced_at: string;
  created_at: string;
  ordered_at: string;
  updated_at: string;
  closed_at: string;
  buyer: Buyer;
  products: Product[];
  manager: Manager;
  tags: Tag[];
  status: Status;
  marketing: Marketing;
  payments: Payment[];
  shipping: Shipping;
  expenses: Expense[];
  custom_fields: CustomField[];
  assigned?: Assigned[];
}

export interface Buyer {
  id: number;
  full_name: string;
  email: string;
  phone: string;
  company_id: number;
  manager_id: number;
}

export interface Product {
  name: string;
  sku: string;
  price: number;
  price_sold: number;
  purchased_price: number;
  discount_percent: number;
  discount_amount: number;
  total_discount: number;
  quantity: number;
  unit_type: string;
  upsale: boolean;
  comment: string;
  product_status_id: number;
  picture: string;
  properties: Property[];
  shipment_type: string;
  warehouse: Warehouse;
  offer: Offer;
}

export interface Property {
  name: string;
  value: string;
}

export interface Warehouse {
  id: number;
  name: string;
  description: string;
  is_active: boolean;
}

export interface Offer {
  id: number;
  product_id: number;
  sku: string;
  barcode: string;
  price: number;
  purchased_price: number;
  quantity: number;
  weight: number;
  length: number;
  width: number;
  height: number;
  properties: Property[];
}

export interface Manager {
  id: number;
  first_name: string;
  last_name: string;
  full_name: string;
  username: string;
  email: string;
  phone: string;
  role_id: number;
  status: string;
  created_at: string;
  updated_at: string;
  last_logged_at: string;
}

export interface Tag {
  id: number;
  name: string;
  alias: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface Status {
  id: number;
  name: string;
  alias: string;
  is_active: boolean;
  group_id: number;
  is_closing_order: boolean;
  is_reserved: boolean;
  created_at: string;
  updated_at: string;
}

export interface Marketing {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: number;
  destination_id: number;
  payment_method_id: number;
  amount: number;
  actual_currency: string;
  transaction_uuid: string;
  description: string;
  status: string;
  fiscal_result: string;
  payment_date: string;
  created_at: string;
  updated_at: string;
}

export interface Shipping {
  delivery_service_id: number;
  tracking_code: string;
  shipping_status: string;
  shipping_address_city: string;
  shipping_address_country: string;
  shipping_address_country_code: string;
  shipping_address_region: string;
  shipping_address_zip: string;
  shipping_secondary_line: string;
  shipping_receive_point: string;
  recipient_full_name: string;
  recipient_phone: string;
  shipping_date_actual: string;
}

export interface Expense {
  id: number;
  destination_id: number;
  expense_type_id: number;
  amount: number;
  actual_currency: string;
  transaction_uuid: string;
  description: string;
  status: string;
  payment_date: string;
  created_at: string;
  updated_at: string;
}

export interface CustomField {
  id: number;
  uuid: string;
  name: string;
  type: string;
  value: string;
}

export interface Assigned {
  id: number;
  first_name: string;
  last_name: string;
  full_name: string;
  username: string;
  email: string;
  phone: string;
  role: Role;
  status: string;
  created_at: string;
  updated_at: string;
  last_logged_at: string;
}

export interface Role {
  id: number;
  name: string;
  alias: string;
}

export interface GetOrdersResponse {
  current_page: number;
  data: Order[];
  total: number;
}

// Admin types

export interface AdminOrder {
  id: number;
  source_uuid: string | null;
  global_source_uuid: string | null;
  status_on_source: string | null;
  source_id: number;
  client_id: number;
  grand_total: number;
  total_discount: number;
  margin_sum: number;
  expenses_sum: number;
  discount_amount: number;
  discount_percent: number;
  shipping_price: number | null;
  taxes: any;
  register_id: number | null;
  fiscal_result: any[];
  fiscal_status: string | null;
  shipping_type_id: number | null;
  manager_id: number;
  status_group_id: number;
  status_id: number;
  closed_from: number;
  status_expired_at: string | null;
  status_changed_at: string;
  parent_id: number | null;
  manager_comment: string | null;
  client_comment: string | null;
  discount_data: AdminDiscountData;
  is_gift: boolean;
  promocode: string | null;
  wrap_price: number | null;
  gift_wrap: boolean;
  payment_status: "not_paid" | "paid" | string;
  gift_message: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string;
  ordered_at: string;
  source_updated_at: string | null;
  deleted_at: string | null;
  tasks_count: number;
  tasks_completed_count: number;
  payments_total: number;
  is_expired: boolean;
  has_reserves: boolean;

  source: AdminSource;
  client: AdminClient;
  shipping: AdminShipping;
  products: AdminProduct[];
  manager: AdminManager;
  assigned: Assigned[];
  marketing: any;
  prep_center_request: any;
  shipping_lists: any[];
  tags: Tag[];
  payments: any[];
  attachments: AdminAttachment[];
  custom_field_values: AdminCustomFieldValue[];
}

interface AdminDiscountData {
  loyalty?: {
    name: string;
    amount: number;
    discount: number;
    level_id: number;
    loyalty_program_id: number;
  };
}

interface AdminSource {
  id: number;
  name: string;
  source_name: string | null;
  source_uuid: string | null;
  driver: string;
  statuses_toggle: any[];
  currency_code: string;
  shop_info: any[];
}

interface AdminClient {
  id: number;
  company_id: number | null;
  full_name: string;
  birthday: string | null;
  phone: string;
  email: string | null;
  note: string | null;
  picture: string;
  image: string | null;
  orders_sum: string;
  discount: number;
  currency: string;
  orders_count: number;
  has_duplicates: number;
  manager_id: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  profiles: AdminClientProfile[];
  company: any;
}

interface AdminClientProfile {
  id: number;
  client_id: number;
  field: string;
  value: string;
}

interface AdminShipping {
  id: number;
  order_id: number;
  delivery_service_id: number | null;
  address_id: number;
  last_history_id: number | null;
  tracking_code: string | null;
  tracking_code_send_at: string | null;
  shipping_status: string | null;
  shipment_payload: any[];
  address_payload: any[];
  is_warehouse: boolean;
  shipping_preferred_method: string | null;
  shipping_address: string | null;
  use_client: boolean;
  recipient_phone: string;
  recipient_full_name: string;
  shipping_address_country: string;
  shipping_address_country_code: string;
  shipping_address_region: string;
  shipping_address_city: string;
  shipping_address_zip: string;
  shipping_receive_point: string;
  shipping_secondary_line: string;
  shipping_date: string | null;
  shipping_date_actual: string | null;
  shipping_date_actual_has_owner: boolean;
  shipping_price: number | null;
  was_shipped: boolean;
  tracking_last_sync: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  full_address: string;
  tracking_sync_failed: boolean;
  delivery_service: any;
  last_history: any;
}

interface AdminProduct {
  id: string;
}

interface AdminManager {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  username: string;
  role_id: number;
  avatar_id: number;
  is_hidden: boolean;
  is_owner: boolean;
  last_logged_at: string;
  full_name: string;
  is_bot: boolean;
  role: AdminRole;
  avatar: AdminAvatar;
}

interface AdminRole {
  id: number;
  name: string;
  alias: string;
  color: string;
}

interface AdminAvatar {
  id: number;
  url: string;
  name: string;
  thumbnail: string;
}

interface AdminAttachment {
  id: number;
  file_id: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  file: FileMeta;
}

interface FileMeta {
  id: number;
  size: number;
  disk: string;
  extension: string;
  original_file_url: string | null;
  original_file_name: string;
  mime_type: string;
  hash: string;
  created_at: string;
  updated_at: string;
  expired_at: string | null;
  url: string;
  name: string;
  thumbnail: string;
}

interface AdminCustomFieldValue {
  id: number;
  field_id: number;
  value: string | number;
  field: {
    id: number;
    name: string;
    uuid: string;
    type: string;
  };
}

export interface Conversation {
  id: number;
  channel_id: number;
  assigned_user_id: number;
  contact_id: number;
  contact_username: string;
  comment: string | null;
  unread_count: number;
  is_spam: boolean;
  external_id: string;
  updated_timestamp: string;
  archived_at: string | null;
  delayed_till: string | null;
  muted_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_message_id: number;
  uuid: number;
  channel: {
    id: number;
    driver: string;
    name: string;
    driver_type: string;
  };
}

export interface StorageUploadResponse {
  directory: string;
  file_name: string;
  hash: string;
  size: number;
  original_file_name: string;
  extension: string;
  mime_type: string;
  disk: string;
  updated_at: string;
  created_at: string;
  id: number;
  url: string;
}
