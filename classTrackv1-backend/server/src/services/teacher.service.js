/**
 * server/src/services/teacher.service.js
 *
 * All business logic for the teacher role.
 * Controllers call these methods — no SQL, no bcrypt, no file I/O in controllers.
 */
const bcrypt   = require('bcryptjs');
const { ApiError } = require('../utils/response.util');
const { effectiveScore } = require('../utils/scoring.util');
const { generateTempPassword } = require('../utils/password.util');
const { generateClassCode } = require('../utils/generateCode.util');
const logger   = require('../utils/logger.util');

const classroomRepo  = require('../repositories/classroom.repository');
const taskRepo       = require('../repositories/task.repository');
const studentRepo    = require('../repositories/student.repository');
const submissionRepo = require('../repositories/submission.repository');
const auditRepo      = require('../repositories/audit.repository');
const notifRepo      = require('../repositories/notification.repository');

// ---------------------------------------------------------------------------
// Classrooms
// ---------------------------------------------------------------------------
async function getMyClassrooms(teacherId) {
  return classroomRepo.listByTeacher(teacherId);
}

async function _requireOwnedClassroom(classroomId, teacherId) {
  const classroom = await classroomRepo.belongsToTeacher(classroomId, teacherId);
  if (!classroom) throw ApiError.notFound('Classroom not found.');
  return classroom;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
async function createTask({ classroomId, teacherId, title, description, instructions, maxScore, dueDate, taskDate }) {
  const classroom = await _requireOwnedClassroom(classroomId, teacherId);

  const taskId = await taskRepo.create({
    classroom_id: Number(classroomId),
    teacher_id:   teacherId,
    title:        title.trim(),
    description:  description  || null,
    instructions: instructions || null,
    max_score:    maxScore     || 100,
    due_date:     dueDate      || null,
    task_date:    taskDate     || null,
  });

  // Bulk-notify every enrolled student immediately
  const studentIds = await notifRepo.getActiveStudentIds(Number(classroomId));
  await notifRepo.bulkInsertForClassroom(studentIds, {
    classroomId: Number(classroomId),
    taskId,
    type:    'task_posted',
    title:   `New task: ${title.trim()}`,
    message: `${classroom.name} has a new task${dueDate ? ` due ${dueDate}` : ''}.`,
  });

  logger.info('Task created, students notified', { taskId, classroomId, studentCount: studentIds.length });
  return taskId;
}

async function updateTask({ taskId, teacherId, title, description, maxScore, dueDate }) {
  const task = await taskRepo.belongsToTeacher(taskId, teacherId);
  if (!task) throw ApiError.notFound('Task not found.');

  const updates = {};
  if (title       !== undefined) updates.title       = title;
  if (description !== undefined) updates.description = description;
  if (maxScore    !== undefined) updates.max_score   = maxScore;
  if (dueDate     !== undefined) updates.due_date    = dueDate || null;

  await taskRepo.updateById(taskId, updates);
  logger.info('Task updated', { taskId, teacherId });
}

async function toggleTaskActive(taskId, teacherId) {
  const task = await taskRepo.belongsToTeacher(taskId, teacherId);
  if (!task) throw ApiError.notFound('Task not found.');
  await taskRepo.toggleActive(taskId);
  logger.info('Task visibility toggled', { taskId, teacherId });
}

async function getClassroomTasks(classroomId, teacherId) {
  await _requireOwnedClassroom(classroomId, teacherId);
  return taskRepo.listByClassroomForTeacher(classroomId);
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------
async function getTaskSubmissions(taskId, teacherId) {
  const task = await taskRepo.belongsToTeacher(taskId, teacherId);
  if (!task) throw ApiError.notFound('Task not found.');

  const students    = await studentRepo.listByClassroom(task.classroom_id);
  const submissions = await submissionRepo.listByTask(taskId);

  const byStudent = {};
  submissions.forEach((s) => {
    s.effective_score = effectiveScore(s);
    byStudent[s.student_id] = s;
  });

  return { task, roster: students.map((s) => ({ student: s, submission: byStudent[s.id] || null })) };
}

async function getSubmissionHistory(submissionId, teacherId) {
  const sub = await submissionRepo.belongsToTeacherClassroom(submissionId, teacherId);
  if (!sub) throw ApiError.notFound('Submission not found.');
  return submissionRepo.getVersionHistory(submissionId);
}

async function overrideScore({ submissionId, teacherId, teacherScore, teacherFeedback }) {
  const sub = await submissionRepo.belongsToTeacherClassroom(submissionId, teacherId);
  if (!sub) throw ApiError.notFound('Submission not found.');

  if (teacherScore !== null && teacherScore !== undefined) {
    const score = Number(teacherScore);
    if (Number.isNaN(score) || score < 0 || score > sub.max_score) {
      throw ApiError.badRequest(`Score must be between 0 and ${sub.max_score}.`);
    }
  }

  await submissionRepo.overrideScore(submissionId, teacherId, teacherScore ?? null, teacherFeedback);

  await notifRepo.insertOne({
    recipientType: 'student', recipientId: sub.student_id, taskId: sub.task_id,
    type:    'score_overridden',
    title:   'Your teacher reviewed your grade',
    message: teacherFeedback || 'Your teacher added a note to your submission.',
  });

  await auditRepo.insert({
    actorType: 'teacher', actorId: teacherId,
    action: 'score_overridden', targetType: 'submission', targetId: submissionId,
    details: { teacherScore },
  });

  logger.info('Score overridden', { submissionId, teacherId, teacherScore });
}

// ---------------------------------------------------------------------------
// Student password reset
// ---------------------------------------------------------------------------
async function resetStudentPassword(studentId, teacherId) {
  const [rows] = await require('../database/connection').pool.query(
    `SELECT s.id, s.name FROM students s
     JOIN classrooms c ON c.id = s.classroom_id
     WHERE s.id = ? AND c.teacher_id = ?`,
    [studentId, teacherId]
  );
  if (!rows.length) throw ApiError.notFound('Student not found in your classrooms.');

  const tempPassword = generateTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);
  await studentRepo.updatePassword(studentId, hash);

  await auditRepo.insert({
    actorType: 'teacher', actorId: teacherId,
    action: 'student_password_reset', targetType: 'student', targetId: studentId,
  });

  logger.info('Student password reset by teacher', { studentId, teacherId });
  return { message: `Password reset for ${rows[0].name}.`, tempPassword };
}

// ---------------------------------------------------------------------------
// Report data builder (shared by PDF + CSV services)
// ---------------------------------------------------------------------------
async function buildClassroomReportData(classroomId, teacherId) {
  const classroom = await _requireOwnedClassroom(classroomId, teacherId);
  const { pool } = require('../database/connection');

  const [tasks]    = await pool.query('SELECT * FROM tasks WHERE classroom_id = ? ORDER BY task_date', [classroomId]);
  const [students] = await pool.query('SELECT * FROM students WHERE classroom_id = ? ORDER BY name', [classroomId]);
  const subs       = await submissionRepo.listForClassroom(classroomId);

  const studentRows = students.map((student) => {
    const submissions = {};
    subs.filter((s) => s.student_id === student.id).forEach((s) => (submissions[s.task_id] = s));
    return { student, submissions };
  });

  return { classroom, tasks, studentRows };
}

module.exports = {
  getMyClassrooms, createTask, updateTask, toggleTaskActive, getClassroomTasks,
  getTaskSubmissions, getSubmissionHistory, overrideScore,
  resetStudentPassword, buildClassroomReportData,
  getDashboardStats, listClassroomsManaged, getClassroomDetails,
  createClassroom, updateClassroom, archiveClassroom, restoreClassroom,
  deleteClassroom, regenerateJoinCode,
};

// ---------------------------------------------------------------------------
// Teacher dashboard
// ---------------------------------------------------------------------------

async function getDashboardStats(teacherId) {
  const [stats, recentActivity] = await Promise.all([
    classroomRepo.getTeacherDashboardStats(teacherId),
    classroomRepo.getRecentActivity(teacherId, 10),
  ]);
  return { ...stats, recentActivity };
}

// ---------------------------------------------------------------------------
// Classroom management
// ---------------------------------------------------------------------------

/** Ownership check for the new management endpoints — unlike
 *  _requireOwnedClassroom (above, relied on by existing task functions and
 *  left untouched), this one excludes soft-deleted classrooms via
 *  findOwnedById, so a deleted classroom can never be edited/archived/
 *  restored/regenerated again. */
async function _requireOwnedActiveClassroom(classroomId, teacherId) {
  const classroom = await classroomRepo.findOwnedById(classroomId, teacherId);
  if (!classroom) throw ApiError.notFound('Classroom not found.');
  return classroom;
}

function _validateClassroomFields({ name, subject, section }) {
  const errors = [];
  if (name !== undefined && !name.trim()) errors.push('Classroom name cannot be blank.');
  if (errors.length) throw ApiError.badRequest('Validation failed.', errors);
}

async function listClassroomsManaged(teacherId, query) {
  const page   = Number(query.page)  || 1;
  const limit  = Number(query.limit) || 20;
  const offset = (page - 1) * limit;

  const { rows, total } = await classroomRepo.listByTeacherManaged({
    teacherId,
    limit,
    offset,
    search:  query.search || null,
    status:  query.status || 'active',
    sortBy:  query.sortBy || 'createdAt',
    sortDir: query.sortDir || 'desc',
  });

  return {
    classrooms: rows.map((r) => ({
      id: r.id, name: r.name, subject: r.subject, section: r.section,
      classCode: r.class_code, isActive: Boolean(r.is_active), createdAt: r.created_at,
      studentCount: Number(r.student_count), taskCount: Number(r.task_count),
      latestActivityAt: r.latest_activity_at,
    })),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

async function getClassroomDetails(classroomId, teacherId) {
  const classroom = await _requireOwnedActiveClassroom(classroomId, teacherId);
  const [studentCount, taskCount] = await Promise.all([
    studentRepo.countBy('classroom_id', classroomId),
    taskRepo.countBy('classroom_id', classroomId),
  ]);
  return {
    id: classroom.id, name: classroom.name, subject: classroom.subject, section: classroom.section,
    classCode: classroom.class_code, isActive: Boolean(classroom.is_active), createdAt: classroom.created_at,
    studentCount, taskCount,
  };
}

async function createClassroom({ name, subject, section, teacherId }) {
  _validateClassroomFields({ name, subject, section });

  const isDuplicate = await classroomRepo.existsDuplicate({ teacherId, name, section });
  if (isDuplicate) {
    throw ApiError.conflict('You already have a classroom with this name and section.');
  }

  const classCode = await generateClassCode(classroomRepo);
  const id = await classroomRepo.create({
    name: name.trim(),
    subject: subject || null,
    section: section || null,
    class_code: classCode,
    teacher_id: teacherId,
    created_by: teacherId,
  });

  await auditRepo.insert({
    actorType: 'teacher', actorId: teacherId,
    action: 'classroom_created', targetType: 'classroom', targetId: id,
    details: { name: name.trim(), classCode },
  });

  logger.info('Classroom created', { classroomId: id, classCode, teacherId });
  return { id, name: name.trim(), subject: subject || null, section: section || null, classCode };
}

async function updateClassroom({ classroomId, teacherId, name, subject, section }) {
  const classroom = await _requireOwnedActiveClassroom(classroomId, teacherId);
  _validateClassroomFields({ name, subject, section });

  const nextName    = name !== undefined ? name.trim() : classroom.name;
  const nextSection = section !== undefined ? section : classroom.section;

  if (name !== undefined || section !== undefined) {
    const isDuplicate = await classroomRepo.existsDuplicate({
      teacherId, name: nextName, section: nextSection, excludeId: classroomId,
    });
    if (isDuplicate) {
      throw ApiError.conflict('You already have a classroom with this name and section.');
    }
  }

  const patch = {};
  if (name !== undefined)    patch.name = nextName;
  if (subject !== undefined) patch.subject = subject || null;
  if (section !== undefined) patch.section = section || null;

  if (Object.keys(patch).length > 0) {
    await classroomRepo.updateFields(classroomId, patch);
    await auditRepo.insert({
      actorType: 'teacher', actorId: teacherId,
      action: 'classroom_updated', targetType: 'classroom', targetId: classroomId,
      details: patch,
    });
  }

  logger.info('Classroom updated', { classroomId, teacherId });
}

async function archiveClassroom(classroomId, teacherId) {
  const classroom = await _requireOwnedActiveClassroom(classroomId, teacherId);
  if (!classroom.is_active) throw ApiError.badRequest('Classroom is already archived.');

  await classroomRepo.archive(classroomId);
  await auditRepo.insert({
    actorType: 'teacher', actorId: teacherId,
    action: 'classroom_archived', targetType: 'classroom', targetId: classroomId,
  });
  logger.info('Classroom archived', { classroomId, teacherId });
}

async function restoreClassroom(classroomId, teacherId) {
  const classroom = await _requireOwnedActiveClassroom(classroomId, teacherId);
  if (classroom.is_active) throw ApiError.badRequest('Classroom is not archived.');

  await classroomRepo.restore(classroomId);
  await auditRepo.insert({
    actorType: 'teacher', actorId: teacherId,
    action: 'classroom_restored', targetType: 'classroom', targetId: classroomId,
  });
  logger.info('Classroom restored', { classroomId, teacherId });
}

/** Soft delete only — the row is kept, `deleted_at` is set, and it's
 *  excluded from every teacher-facing query from that point on. There is
 *  no un-delete; that's what distinguishes it from archive/restore. */
async function deleteClassroom(classroomId, teacherId) {
  await _requireOwnedActiveClassroom(classroomId, teacherId);

  await classroomRepo.softDelete(classroomId);
  await auditRepo.insert({
    actorType: 'teacher', actorId: teacherId,
    action: 'classroom_deleted', targetType: 'classroom', targetId: classroomId,
  });
  logger.info('Classroom soft-deleted', { classroomId, teacherId });
}

async function regenerateJoinCode(classroomId, teacherId) {
  await _requireOwnedActiveClassroom(classroomId, teacherId);

  const classCode = await generateClassCode(classroomRepo);
  await classroomRepo.regenerateCode(classroomId, classCode);
  await auditRepo.insert({
    actorType: 'teacher', actorId: teacherId,
    action: 'classroom_code_regenerated', targetType: 'classroom', targetId: classroomId,
    details: { classCode },
  });
  logger.info('Classroom join code regenerated', { classroomId, teacherId });
  return { classCode };
}
