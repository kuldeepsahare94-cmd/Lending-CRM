const { createActivityRouter } = require('./activityRouterFactory');

module.exports = createActivityRouter({
  moduleApiName: 'calls',
  tableName: 'calls',
  titleColumn: 'call_subject',
  columns: [
    { name: 'call_subject' },
    { name: 'related_module' },
    { name: 'related_record_id' },
    { name: 'phone_number' },
    { name: 'call_type' },
    { name: 'direction' },
    { name: 'start_time' },
    { name: 'duration_minutes' },
    { name: 'assigned_user_id' },
    { name: 'status', default: 'Completed' },
    { name: 'call_outcome' },
    { name: 'call_recording_url' },
    { name: 'notes' },
    { name: 'follow_up_date' },
    { name: 'next_action' },
  ],
});
