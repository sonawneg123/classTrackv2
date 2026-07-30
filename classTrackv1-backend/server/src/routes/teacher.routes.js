/**
 * server/src/routes/teacher.routes.js
 */
const { Router } = require('express');
const controller  = require('../controllers/teacher.controller');
const teacherValidator = require('../validators/teacher.validator');
const { authenticate, authorizeRoles, authorizePermissions } = require('../middleware/auth.middleware');
const { PERMISSIONS } = require('../constants/permissions.constants');
const { upload, validateFileSignature } = require('../middleware/upload.middleware');
const validate = require('../middleware/validate.middleware');

const router = Router();
router.use(authenticate, authorizeRoles('teacher'));

/**
 * @openapi
 * /v1/teacher/dashboard:
 *   get:
 *     tags: [Teacher]
 *     summary: Teacher dashboard stats
 *     description: Total classrooms, total students, active assignments, pending evaluations, and recent activity — one aggregated round trip, no N+1.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Dashboard stats }
 *       401: { description: Missing or invalid access token }
 */
router.get('/dashboard', controller.getDashboardStats);

/**
 * @openapi
 * /v1/teacher/classrooms/manage:
 *   get:
 *     tags: [Teacher]
 *     summary: List my classrooms (paginated, searchable, sortable, filterable)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, archived, all], default: active }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [name, createdAt, studentCount, taskCount], default: createdAt }
 *       - in: query
 *         name: sortDir
 *         schema: { type: string, enum: [asc, desc], default: desc }
 *     responses:
 *       200: { description: Paginated classroom list }
 *   post:
 *     tags: [Teacher]
 *     summary: Create a classroom
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:    { type: string, minLength: 2, maxLength: 150 }
 *               subject: { type: string, maxLength: 100 }
 *               section: { type: string, maxLength: 50 }
 *     responses:
 *       201: { description: Classroom created }
 *       409: { description: Duplicate classroom (same name + section already exists for this teacher) }
 */
router.get('/classrooms/manage', validate(teacherValidator.listClassrooms), controller.listClassroomsManaged);
router.post('/classrooms/manage', authorizePermissions(PERMISSIONS.CLASSROOM_MANAGE_OWN), validate(teacherValidator.createClassroom), controller.createClassroom);

/**
 * @openapi
 * /v1/teacher/classrooms/manage/{classroomId}:
 *   get:
 *     tags: [Teacher]
 *     summary: Get classroom details
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: classroomId, required: true, schema: { type: integer } }]
 *     responses: { 200: { description: Classroom details }, 404: { description: Not found or not yours } }
 *   patch:
 *     tags: [Teacher]
 *     summary: Update a classroom
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: classroomId, required: true, schema: { type: integer } }]
 *     responses: { 200: { description: Updated }, 409: { description: Duplicate name+section } }
 *   delete:
 *     tags: [Teacher]
 *     summary: Delete a classroom (soft delete only — not reversible via restore)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: classroomId, required: true, schema: { type: integer } }]
 *     responses: { 200: { description: Deleted } }
 */
router.get('/classrooms/manage/:classroomId', validate(teacherValidator.classroomIdParam), controller.getClassroomDetails);
router.patch('/classrooms/manage/:classroomId', authorizePermissions(PERMISSIONS.CLASSROOM_MANAGE_OWN), validate(teacherValidator.updateClassroom), controller.updateClassroom);
router.delete('/classrooms/manage/:classroomId', authorizePermissions(PERMISSIONS.CLASSROOM_MANAGE_OWN), validate(teacherValidator.classroomIdParam), controller.deleteClassroom);

/**
 * @openapi
 * /v1/teacher/classrooms/manage/{classroomId}/archive:
 *   patch:
 *     tags: [Teacher]
 *     summary: Archive a classroom
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: classroomId, required: true, schema: { type: integer } }]
 *     responses: { 200: { description: Archived }, 400: { description: Already archived } }
 */
router.patch('/classrooms/manage/:classroomId/archive', authorizePermissions(PERMISSIONS.CLASSROOM_MANAGE_OWN), validate(teacherValidator.classroomIdParam), controller.archiveClassroom);

/**
 * @openapi
 * /v1/teacher/classrooms/manage/{classroomId}/restore:
 *   patch:
 *     tags: [Teacher]
 *     summary: Restore an archived classroom
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: classroomId, required: true, schema: { type: integer } }]
 *     responses: { 200: { description: Restored }, 400: { description: Not archived } }
 */
router.patch('/classrooms/manage/:classroomId/restore', authorizePermissions(PERMISSIONS.CLASSROOM_MANAGE_OWN), validate(teacherValidator.classroomIdParam), controller.restoreClassroom);

/**
 * @openapi
 * /v1/teacher/classrooms/manage/{classroomId}/regenerate-code:
 *   patch:
 *     tags: [Teacher]
 *     summary: Regenerate a classroom's join code
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: classroomId, required: true, schema: { type: integer } }]
 *     responses: { 200: { description: New join code issued } }
 */
router.patch('/classrooms/manage/:classroomId/regenerate-code', authorizePermissions(PERMISSIONS.CLASSROOM_MANAGE_OWN), validate(teacherValidator.classroomIdParam), controller.regenerateJoinCode);

// Classrooms
router.get('/classrooms',                             controller.getMyClassrooms);
router.get('/classrooms/:classroomId/tasks',          controller.getClassroomTasks);
router.post('/classrooms/:classroomId/tasks',         validate(teacherValidator.createTask),   controller.createTask);
router.get('/classrooms/:classroomId/report',         controller.downloadClassroomReport);
router.get('/classrooms/:classroomId/export-csv',     controller.downloadClassroomCsv);

// Tasks
router.patch('/tasks/:taskId',                        validate(teacherValidator.updateTask),    controller.updateTask);
router.patch('/tasks/:taskId/toggle-active',          controller.toggleTaskActive);
router.get('/tasks/:taskId/submissions',              controller.getTaskSubmissions);

// Submissions
router.get('/submissions/:submissionId/history',      controller.getSubmissionHistory);
router.post('/submissions/:submissionId/reanalyze',   controller.reanalyzeSubmission);
router.patch('/submissions/:submissionId/override-score', validate(teacherValidator.overrideScore), controller.overrideScore);

// Students
router.post('/students/:studentId/reset-password',    controller.resetStudentPassword);

module.exports = router;
