// Fills the database with invented sample data so the app has something to show.
// Run with: npm run seed
import db from './db.js';

const SCHOOLS = [
  {
    name: 'Green Valley Public School',
    code: 'GVPS-01',
    city: 'Kochi',
    state: 'Kerala',
    contact_name: 'Leena Thomas',
    contact_email: 'principal@example.com',
    contact_phone: '+91 90000 00001',
    teachers: [
      { name: 'Asha Menon', grade: 'Grade 5', subjects: 'Mathematics, Science' },
      { name: 'Rahul Verma', grade: 'Grade 8', subjects: 'English' },
      { name: 'Priya Nair', grade: 'Grade 10', subjects: 'Physics, Chemistry' },
    ],
  },
  {
    name: 'Riverside Higher Secondary',
    code: 'RHS-02',
    city: 'Thrissur',
    state: 'Kerala',
    contact_name: 'Sanjay Pillai',
    contact_email: 'office@example.com',
    contact_phone: '+91 90000 00002',
    teachers: [
      { name: 'Meera Joseph', grade: 'Grade 6', subjects: 'Social Studies' },
      { name: 'Anil Kumar', grade: 'Grades 9-10', subjects: 'Mathematics' },
    ],
  },
];

const insertSchool = db.prepare(
  `INSERT INTO schools (name, code, city, state, contact_name, contact_email, contact_phone)
   VALUES (@name, @code, @city, @state, @contact_name, @contact_email, @contact_phone)`
);
const insertTeacher = db.prepare(
  'INSERT INTO teachers (school_id, name, grade, subjects) VALUES (@school_id, @name, @grade, @subjects)'
);
const insertAssessment = db.prepare(
  `INSERT INTO assessments (school_id, teacher_id, title, assessment_date, subject, status, notes)
   VALUES (@school_id, @teacher_id, @title, @assessment_date, @subject, @status, @notes)`
);

const seed = db.transaction(() => {
  for (const school of SCHOOLS) {
    const { teachers, ...fields } = school;
    const schoolId = insertSchool.run(fields).lastInsertRowid;

    for (const teacher of teachers) {
      const teacherId = insertTeacher.run({ ...teacher, school_id: schoolId }).lastInsertRowid;

      if (teacher.name === 'Asha Menon') {
        insertAssessment.run({
          school_id: schoolId,
          teacher_id: teacherId,
          title: 'Term 1 subject knowledge test',
          assessment_date: new Date().toISOString().slice(0, 10),
          subject: 'Mathematics',
          status: 'draft',
          notes: '',
        });
      }
    }
  }
});

const existing = db.prepare('SELECT COUNT(*) AS count FROM schools').get().count;
if (existing > 0) {
  console.log(`There are already ${existing} school(s) in the database — nothing seeded.`);
} else {
  seed();
  console.log('Sample schools, teachers and one assessment added. Run "npm start" and open the app.');
}
