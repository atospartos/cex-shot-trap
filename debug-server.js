// debug-server.js
require('dotenv').config();

// Перехват всех ошибок
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err);
    console.error(err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ UNHANDLED REJECTION:', err);
    console.error(err.stack);
    process.exit(1);
});

console.log('🚀 Начинаем загрузку модулей...');

try {
    console.log('1. Загрузка express...');
    const express = require('express');
    console.log('   ✅ OK');
    
    console.log('2. Загрузка cors...');
    const cors = require('cors');
    console.log('   ✅ OK');
    
    console.log('3. Загрузка path...');
    const path = require('path');
    console.log('   ✅ OK');
    
    console.log('4. Загрузка config...');
    const config = require('./charts/config');
    console.log('   ✅ OK');
    
    console.log('5. Загрузка timeHelpers...');
    const timeHelpers = require('./charts/utils/timeHelpers');
    console.log('   ✅ OK');
    
    console.log('6. Загрузка mexcService...');
    const mexcService = require('./charts/services/mexcService');
    console.log('   ✅ OK');
    
    console.log('7. Загрузка mobulaService...');
    const mobulaService = require('./charts/services/mobulaService');
    console.log('   ✅ OK');
    
    console.log('8. Загрузка drawdownAnalyzer...');
    const analyzer = require('./charts/analyzers/drawdownAnalyzer');
    console.log('   ✅ OK');
    
    console.log('9. Загрузка tokenService...');
    const tokenService = require('./charts/services/tokenService');
    console.log('   ✅ OK');
    
    console.log('10. Загрузка api routes...');
    const apiRoutes = require('./charts/routes/api');
    console.log('   ✅ OK');
    
    console.log('\n🚀 Все модули загружены, создаём сервер...');
    
    const app = express();
    const PORT = process.env.PORT || 3000;
    
    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));
    
    app.use('/api', apiRoutes);
    
    const server = app.listen(PORT, () => {
        console.log(`\n✅ Сервер запущен: http://localhost:${PORT}`);
        console.log(`   Поддерживаемые таймфреймы: ${Object.keys(config.INTERVAL_CONFIG).join(', ')}`);
    });
    
    // Обработка сигналов завершения
    process.on('SIGINT', () => {
        console.log('\n👋 Получен SIGINT, завершаем работу...');
        server.close(() => process.exit(0));
    });
    
} catch (error) {
    console.error('\n❌ ОШИБКА ПРИ ЗАГРУЗКЕ:');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
}