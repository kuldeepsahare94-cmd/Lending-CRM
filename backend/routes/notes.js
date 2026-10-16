const { createActivityRouter } = require('./activityRouterFactory');

module.exports = createActivityRouter({
  moduleApiName: 'notes',
  tableName: 'notes',
  titleColumn: 'body',
  columns: [
    { name: 'title' },
    { name: 'body' },
    { name: 'related_module' },
    { name: 'related_record_id' },
    { name: 'pinned', default: 0 },
    { name: 'visibility', default: 'Everyone' },
  ],
});
