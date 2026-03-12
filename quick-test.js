import axios from 'axios';

// Быстрый тест - замените эти значения
const WEBHOOK_URL = 'http://127.0.0.1:10000/webhook/file/bare-comp-message';
const ORDER_ID = 12109; // Замените на реальный ID заказа

// Простой вебхук для тестирования
const testWebhook = async () => {
  try {
    console.log('🧪 Быстрый тест вебхука...');
    console.log(`📋 Order ID: ${ORDER_ID}`);
    console.log(`📤 URL: ${WEBHOOK_URL}`);
    
    const response = await axios.post(WEBHOOK_URL, {
      event: "order.change_order_status",
      context: {
        id: ORDER_ID,
        status_id: 15,
        client_id: 67890,
        manager_id: 1,
        status_changed_at: new Date().toISOString()
      }
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    
    console.log('✅ Успешно! Статус:', response.status);
    console.log('📄 Ответ:', response.data);
    
  } catch (error) {
    console.log(error);
    console.error('❌ Ошибка:', error.message);
    if (error.response) {
      console.error('📊 Статус:', error.response.status);
      console.error('📄 Ответ:', error.response.data);
    }
  }
};

// Запуск
testWebhook();
