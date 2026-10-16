const { createActivityRouter } = require('./activityRouterFactory');

module.exports = createActivityRouter({
  moduleApiName: 'emails',
  tableName: 'emails',
  titleColumn: 'subject',
  columns: [
    { name: 'subject' },
    { name: 'from_address' },
    { name: 'to_address' },
    { name: 'cc_address' },
    { name: 'related_module' },
    { name: 'related_record_id' },
    { name: 'direction', default: 'Sent' },
    { name: 'status', default: 'Sent' },
    { name: 'body' },
    { name: 'sent_at' },
  ],
});
