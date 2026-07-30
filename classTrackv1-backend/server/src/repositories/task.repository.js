/**
 * server/src/repositories/task.repository.js
 */
const BaseRepository = require('./base.repository');

class TaskRepository extends BaseRepository {
  constructor() { super('tasks'); }

  async listByClassroomForTeacher(classroomId) {
    const [rows] = await this.pool.query(
      `SELECT t.*,
              COUNT(DISTINCT sub.id)                                  AS submission_count,
              (SELECT COUNT(*) FROM students WHERE classroom_id = t.classroom_id) AS student_count
       FROM tasks t
       LEFT JOIN submissions sub ON sub.task_id = t.id
       WHERE t.classroom_id = ?
       GROUP BY t.id
       ORDER BY t.task_date DESC, t.created_at DESC`,
      [classroomId]
    );
    return rows;
  }

  async listForStudent(classroomId, studentId) {
    const [rows] = await this.pool.query(
      `SELECT t.*, sub.id AS submission_id, sub.status AS submission_status,
              sub.ai_score, sub.teacher_score, sub.attempt_number
       FROM tasks t
       LEFT JOIN submissions sub ON sub.task_id = t.id AND sub.student_id = ?
       WHERE t.classroom_id = ? AND t.is_active = 1
       ORDER BY t.task_date DESC, t.created_at DESC`,
      [studentId, classroomId]
    );
    return rows;
  }

  async belongsToTeacher(taskId, teacherId) {
    const [rows] = await this.pool.query(
      `SELECT t.* FROM tasks t
       JOIN classrooms c ON c.id = t.classroom_id
       WHERE t.id = ? AND c.teacher_id = ?`,
      [taskId, teacherId]
    );
    return rows[0] || null;
  }

  async toggleActive(taskId) {
    return this.toggleBoolById(taskId, 'is_active');
  }
}

module.exports = new TaskRepository();
