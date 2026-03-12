import axios from 'axios';

// Конфигурация для тестирования
const WEBHOOK_URL = 'http://localhost:3000/webhook/keycrm'; // URL вашего вебхука
const ORDER_ID = 12345; // Замените на реальный ID заказа для тестирования
const PHOTO_APPROVAL_CHAT_ID = 'YOUR_CHAT_ID_HERE'; // Замените на ID чата для уведомлений

// Имитация вебхука от KeyCRM при изменении статуса заказа
const webhookPayload = {
  event: "order.change_order_status",
  context: {
    id: ORDER_ID,
    source_uuid: "test-uuid-123",
    global_source_uuid: "global-test-uuid-456",
    status_on_source: "processing",
    source_id: 1,
    client_id: 67890,
    grand_total: 1500.00,
    total_discount: 0,
    margin_sum: 300.00,
    expenses_sum: 0,
    discount_amount: 0,
    discount_percent: 0,
    shipping_price: "0",
    taxes: "0",
    register_id: null,
    fiscal_result: [],
    fiscal_status: "pending",
    shipping_type_id: 1,
    manager_id: 1,
    status_group_id: 2,
    status_id: 15, // Статус, который должен триггерить отправку фото
    closed_from: null,
    status_changed_at: new Date().toISOString(),
    status_expired_at: null,
    parent_id: null,
    manager_comment: null,
    client_comment: null,
    discount_data: {
      loyalty: {
        name: "Standard",
        amount: 0,
        discount: 0,
        level_id: 1,
        loyalty_program_id: 1
      },
      individual: {
        discount: 0
      }
    },
    is_gift: false,
    promocode: "",
    wrap_price: "0",
    gift_wrap: false,
    payment_status: "paid",
    gift_message: null,
    last_synced_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    ordered_at: new Date().toISOString(),
    source_updated_at: new Date().toISOString(),
    deleted_at: null,
    tasks_count: 0,
    tasks_completed_count: 0,
    payments_total: 1500.00,
    is_expired: false,
    has_reserves: false
  }
};

async function testWebhook() {
  try {
    console.log('🚀 Отправляю тестовый вебхук...');
    console.log(`📋 Order ID: ${ORDER_ID}`);
    console.log(`📤 URL: ${WEBHOOK_URL}`);
    console.log('');

    const response = await axios.post(WEBHOOK_URL, webhookPayload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'KeyCRM-Webhook-Test/1.0'
      },
      timeout: 30000
    });

    console.log('✅ Вебхук успешно отправлен!');
    console.log(`📊 Статус ответа: ${response.status}`);
    console.log(`📄 Тело ответа:`, JSON.stringify(response.data, null, 2));

  } catch (error) {
    console.error('❌ Ошибка при отправке вебхука:');
    
    if (error.response) {
      console.error(`📊 Статус: ${error.response.status}`);
      console.error(`📄 Ответ сервера:`, JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('🌐 Ошибка сети - сервер не отвечает');
    } else {
      console.error('💥 Ошибка:', error.message);
    }
  }
}

// Функция для тестирования с разными статусами
async function testDifferentStatuses() {
  const testStatuses = [15, 16, 17, 18]; // Разные статусы для тестирования
  
  console.log('🧪 Тестирование с разными статусами заказов...\n');
  
  for (const statusId of testStatuses) {
    console.log(`📋 Тестирую статус ID: ${statusId}`);
    
    const testPayload = {
      ...webhookPayload,
      context: {
        ...webhookPayload.context,
        status_id: statusId
      }
    };
    
    try {
      const response = await axios.post(WEBHOOK_URL, testPayload, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'KeyCRM-Webhook-Test/1.0'
        },
        timeout: 30000
      });
      
      console.log(`✅ Статус ${statusId}: Успешно (${response.status})`);
    } catch (error) {
      console.log(`❌ Статус ${statusId}: Ошибка - ${error.message}`);
    }
    
    // Пауза между запросами
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// Основная функция
export async function main() {
  console.log('🔧 Тестирование вебхука KeyCRM для загрузки файлов\n');
  
  // Проверяем, что все необходимые параметры заполнены
  if (PHOTO_APPROVAL_CHAT_ID === 'YOUR_CHAT_ID_HERE') {
    console.log('⚠️  ВНИМАНИЕ: Не забудьте заменить PHOTO_APPROVAL_CHAT_ID на реальный ID чата!');
    console.log('   Это ID чата, куда будут приходить уведомления об ошибках загрузки файлов.\n');
  }
  
  if (ORDER_ID === 12345) {
    console.log('⚠️  ВНИМАНИЕ: Замените ORDER_ID на реальный ID заказа для тестирования!\n');
  }
  
  console.log('📋 Конфигурация:');
  console.log(`   Webhook URL: ${WEBHOOK_URL}`);
  console.log(`   Order ID: ${ORDER_ID}`);
  console.log(`   Chat ID: ${PHOTO_APPROVAL_CHAT_ID}\n`);
  
  // Тестируем основной вебхук
  await testWebhook();
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Тестируем с разными статусами
  await testDifferentStatuses();
  
  console.log('\n🎯 Тестирование завершено!');
  console.log('\n📝 Что тестируется:');
  console.log('   1. Получение вебхука от KeyCRM');
  console.log('   2. Скачивание файла из attachment');
  console.log('   3. Загрузка файла в KeyCRM storage');
  console.log('   4. Отправка сообщения с новым URL файла');
  console.log('   5. Обработка ошибок и уведомления в Telegram');
}

// // Запуск тестирования
// module.exports = {
//   testWebhook,
//   testDifferentStatuses,
//   webhookPayload
// };
