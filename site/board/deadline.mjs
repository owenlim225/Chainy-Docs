export const todayInManila = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(now);

export const isOverdue = (task, today) => Boolean(task.end) && task.status !== 'Done' && task.end < today;
