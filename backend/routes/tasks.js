const { createActivityRouter } = require('./activityRouterFactory');

module.exports = createActivityRouter({
  moduleApiName: 'tasks',
  tableName: 'tasks',
  titleColumn: 'task_title',
  columns: [
    { name: 'task_title' },
    { name: 'related_module' },
    { name: 'related_record_id' },
    { name: 'assigned_to_id' },
    { name: 'priority', default: 'Medium' },
    { name: 'status', default: 'Not Started' },
    { name: 'start_date' },
    { name: 'due_date' },
    { name: 'description' },
    { name: 'completed_date' },
  ],
});
