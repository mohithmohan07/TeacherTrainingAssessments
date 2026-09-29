// The layout of the teacher assessment papers the generator writes, taken from
// the programme's sample papers. A paper has up to three sections of one hour
// each: A (communication, 35 marks), B (subject knowledge, classroom management
// and child psychology, 35 marks) and C (computer knowledge and digital
// teaching skills, 30 marks). Each section is a few case-study questions with
// lettered parts and fixed marks per part. Questions are numbered Q1-Q4 in A,
// Q5-Q8 in B and Q9-Q11 in C, whichever sections a paper includes.
//
// `purpose` tells Gemini what each question and part must test, and `ideas`
// lists situations that suit each group of levels. Both describe the sample
// papers in our own words; no sample text is copied.

export const SECTION_MINUTES = 60;

const SECTION_A = {
  key: 'A',
  start: 1,
  heading: 'Section A - Interpersonal & Instructional Communication Skills',
  focus: 'how the teacher communicates with learners, parents and colleagues, in class and in writing',
  questions: [
    {
      title: 'Student & Parent Communication',
      purpose:
        'A named learner and their parent in a situation that needs careful, two-way communication: a concern about the learner, or a parent who disagrees with the school\'s approach. Describe both sides concretely.',
      ideas: {
        early: [
          'a parent who wants daily written homework for a young child in a play-based classroom',
          'a child anxious about reading aloud, and an upset parent who feels the targets are too high',
          'a child who cries at drop-off every morning while the parent worries the child is not settling',
        ],
        school: [
          'a learner whose marks and participation have dropped, with parents who blame friends or phone use',
          'parents who want more tests and homework while the teacher uses projects and inquiry',
          'a learner caught copying in a test, and parents who deny it',
        ],
        senior: [
          'a high-achieving learner thinking of switching stream or career after one poor result, pulled between parents, friends and social media',
          'parents who want their child to drop a subject to focus on entrance coaching',
          'a learner who wants a career the parents oppose',
        ],
      },
      parts: [
        { marks: 3, purpose: 'How the teacher speaks to the learner, or opens the conversation, to understand the situation and build trust without criticism.' },
        { marks: 3, purpose: 'How the teacher explains their professional reasoning or expectations to the parent with empathy and concrete examples.' },
        { marks: 2, purpose: 'How the teacher uses evidence, keeps professional boundaries and respects everyone\'s views, including the learner\'s.' },
        { marks: 2, purpose: 'How the teacher closes the conversation and follows up, with a short practical plan over a stated period.' },
      ],
    },
    {
      title: 'Instructional Classroom Communication',
      purpose:
        'A lesson or activity where the way the teacher communicates decides whether learners understand and take part. Name the class, the topic or activity, and what learners say or do.',
      ideas: {
        early: [
          'a multi-step colouring, cutting and sorting activity that children start before understanding the instructions',
          'a few children answer every question, others stay silent, and one child who keeps getting answers wrong stops trying',
          'a circle-time story where attention drops after a few minutes',
        ],
        school: [
          'learners who only ask "Will this come in the exam?" when a new chapter starts, and ignore the learning objectives',
          'an inquiry activity where learners ask questions beyond the textbook, some with no single answer',
          'a group task where the instructions are misread and groups go off track',
        ],
        senior: [
          'learners who ask only for "important questions" and rely on rote learning before the board examination',
          'a demanding derivation, proof or case analysis where half the class loses the thread',
          'a revision period where learners must balance board and entrance examination preparation',
        ],
      },
      parts: [
        { marks: 2, purpose: 'Communicating the purpose, instructions or success criteria clearly for this age group, with language, examples or visual cues.' },
        { marks: 2, purpose: 'Checking understanding before and during the task without asking "Do you understand?".' },
        { marks: 2, purpose: 'Supporting learners who struggle to take part: shy or silent learners, those still learning the language, those who give wrong answers or get frustrated.' },
        { marks: 2, purpose: 'Closing the lesson or activity so learning is consolidated and the teacher knows whether the outcomes were met.' },
      ],
    },
    {
      title: 'Professional Collaboration & Communication',
      purpose:
        'A sensitive situation the teacher cannot solve alone, about one learner\'s well-being or a pattern across several learners, which needs parents, colleagues, the counsellor or the coordinator. Name the roles involved.',
      ideas: {
        early: [
          'several children arriving late, tired and without their things, needing a meeting with the coordinator, counsellor and support staff',
          'a child whose behaviour has changed suddenly after a family event',
          'a disagreement with an assistant teacher about how to handle a child\'s tantrums',
        ],
        school: [
          'a learner whose participation and performance have declined for a month, with signs of problems at home',
          'a group of learners excluding a classmate online and in class',
          'subject teachers setting conflicting homework loads that overwhelm a class',
        ],
        senior: [
          'a learner who privately says they are overwhelmed by entrance examinations and family expectations, and asks for confidentiality',
          'a learner showing signs of burnout and skipping classes for coaching',
          'attendance dropping sharply in a class before the board examination',
        ],
      },
      parts: [
        { marks: 2, purpose: 'Opening the conversation or sharing observations respectfully, without blame.' },
        { marks: 2, purpose: 'Handling confidentiality and boundaries: when and how to involve parents, the counsellor or colleagues, and how to resolve differing views.' },
        { marks: 3, purpose: 'A coordinated plan over a stated period, and how the collaboration will help the learners\' well-being and learning.' },
      ],
    },
    {
      title: 'Formal Professional Communication',
      purpose:
        'A situation that calls for a formal written document to the Principal: a report on an observed trend or on examination results, a proposal for a school event or initiative, or a reflective report on the teacher\'s own lesson. The scenario ends by asking for the document, and its five parts are the headings the document must contain.',
      components: true,
      ideas: {
        early: [
          'a reflective report after noticing that few children took part in their own period, attention faded after fifteen minutes and transitions were slow',
          'a report on weak phonics and sentence writing across the early classes',
          'a proposal for a parent-and-child reading week',
        ],
        school: [
          'a proposal for an interdisciplinary, experiential project week',
          'a report on weak performance in one topic across sections, with recommendations',
          'a proposal for a peer-tutoring programme',
        ],
        senior: [
          'a report on the first pre-board results, with measures to improve board results',
          'a proposal for a career guidance and stream counselling programme',
          'a report on how coaching-class overload is affecting attendance and performance',
        ],
      },
      parts: [
        { marks: 2, purpose: 'First heading, e.g. Summary of Concern, Objectives, or What I Observed.' },
        { marks: 2, purpose: 'Second heading, e.g. Relevant Evidence, Proposed Activities, or Possible Reasons.' },
        { marks: 2, purpose: 'Third heading, e.g. Analysis of Causes, Expected Learning Outcomes, or Changes for the Next Lesson.' },
        { marks: 2, purpose: 'Fourth heading, e.g. Practical Recommendations, Resources Required, or Communication Strategies.' },
        { marks: 2, purpose: 'Fifth heading, e.g. Monitoring Plan and Review Timeline, or Evaluating Participation and Learning.' },
      ],
    },
  ],
};

const SECTION_B_SUBJECT = {
  key: 'B',
  start: 5,
  heading: 'Section B - Knowledge Proficiency, Classroom Management & Child Psychology',
  focus: 'the teacher\'s own subject knowledge, how they teach and assess it, how they manage the class, and child or adolescent psychology',
  questions: [
    {
      purpose:
        'A specific topic from the syllabus, with the concrete errors or misconceptions learners at this level show (quote what learners wrongly say or write).',
      ideas: {
        early: [
          'a concept taught through play, such as number sense, sorting and patterns, or phonemic awareness, where children succeed by rote but not with understanding',
        ],
      },
      parts: [
        { marks: 4, purpose: 'Explain the concept accurately at teacher level and correct the misconception, with examples.' },
        { marks: 3, purpose: 'Analyse why learners of this age struggle with it and outline one concrete activity that addresses it.' },
        { marks: 3, purpose: 'Design a short diagnostic task (e.g. predict-observe-explain, or a transfer task) that tests application rather than recall.' },
      ],
    },
    {
      purpose: 'Introducing another topic that learners find abstract or hard to connect to something concrete.',
      ideas: {
        early: ['one play-based activity meant to build number sense, vocabulary and observation together, where some children lose interest after a few minutes'],
      },
      parts: [
        { marks: 3, purpose: 'An interactive, activity-based teaching strategy that makes the idea visible or hands-on.' },
        { marks: 3, purpose: 'Two quick formative assessment techniques to check understanding during the lesson, without a formal written test for young children.' },
        { marks: 2, purpose: 'A differentiated activity that supports struggling learners and stretches advanced ones.' },
      ],
    },
    {
      purpose:
        'A realistic classroom, lab, field or practical session where several management or safety problems happen at once. List them concretely.',
      ideas: {
        early: ['one child refuses to share materials, two argue over the same resource, and another is upset after being corrected and stops working'],
      },
      parts: [
        { marks: 4, purpose: 'Analyse the situation and give two immediate, non-confrontational actions to restore order, safety and fair access.' },
        { marks: 3, purpose: 'Two long-term preventive routines or roles that keep the session orderly.' },
        { marks: 2, purpose: 'Ensuring individual accountability and communicating the standards to parents.' },
      ],
    },
    {
      purpose:
        'A named learner of a stated age with a subject-specific psychological difficulty (anxiety, perfectionism, peer comparison, withdrawal). Describe the behaviour in detail.',
      ideas: {
        early: ['a child who avoids group work and can do tasks alone but cannot explain their thinking, observed over several weeks'],
      },
      parts: [
        { marks: 3, purpose: 'Analyse the behaviour through child or adolescent psychology.' },
        { marks: 3, purpose: 'Two supportive classroom interventions that rebuild confidence.' },
        { marks: 2, purpose: 'A monitoring plan over a stated number of weeks, working with parents and the school counsellor.' },
      ],
    },
  ],
};

// Arts, music, dance and on-field PE teachers get a Section B on child
// psychology and classroom management only, with no subject knowledge question.
const SECTION_B_SPECIALIST = {
  key: 'B',
  start: 5,
  heading: 'Section B - Child Psychology & Classroom Management',
  focus: 'child psychology and managing a practical, activity-based class in this specialist subject',
  questions: [
    {
      purpose: 'During a lesson a learner reacts emotionally (gives up, hides, says something negative about themselves) after a setback or peer reaction.',
      parts: [
        { marks: 3, purpose: 'Analyse the response in terms of self-concept, social comparison, fear of evaluation or avoidance.' },
        { marks: 3, purpose: 'The immediate response that protects the learner\'s dignity, corrects peers and keeps the lesson going.' },
        { marks: 2, purpose: 'Differentiated exercises that build skill and confidence without forcing public performance.' },
        { marks: 2, purpose: 'Two forms of feedback that praise effort and strategy rather than labelling talent.' },
      ],
    },
    {
      purpose: 'A disorderly practical session: rushing for materials or equipment, arguments, working during instructions, slow pack-up, safety at risk.',
      parts: [
        { marks: 3, purpose: 'Design routines for allocating, using, signalling, moving between activities and putting materials away.' },
        { marks: 3, purpose: 'Reinforcing the routines and responding to repeated misuse without shouting or punishing the whole class.' },
        { marks: 3, purpose: 'Keeping enthusiasm and creative exploration while holding predictable boundaries.' },
      ],
    },
    {
      purpose: 'Two learners behave in ways that disturb the session but do not seem intentional (sensory distress, difficulty waiting, restlessness).',
      parts: [
        { marks: 3, purpose: 'Distinguish possible sensory, attention, anxiety and task-structure factors without diagnosing.' },
        { marks: 3, purpose: 'Reasonable adjustments to space, timing, schedules, breaks and ways of taking part.' },
        { marks: 2, purpose: 'Explaining the adjustments to the class without singling out or stigmatising anyone.' },
      ],
    },
    {
      purpose: 'Group work or a performance rehearsal turns tense: stronger learners blame weaker ones and some rely entirely on the teacher.',
      parts: [
        { marks: 2, purpose: 'Establishing shared goals and individual responsibilities that build interdependence rather than blame.' },
        { marks: 3, purpose: 'Strategies and questioning that help learners find and fix errors and give specific peer feedback.' },
        { marks: 3, purpose: 'An assessment method that recognises preparation, collaboration and quality of work.' },
      ],
    },
  ],
};

const SECTION_C = {
  key: 'C',
  start: 9,
  heading: 'Section C - Computer Knowledge & Digital Teaching Skills',
  focus: 'how confidently and responsibly the teacher uses computers, digital resources and AI in teaching and school work',
  questions: [
    {
      purpose:
        'Everyday digital situations in school work that test safe, organised and professional handling of information: account and data security, sharing student data or photos, documents that break when shared, or organising years of files. Give two or three concrete situations, or one detailed one.',
      ideas: {
        early: [
          'an email that looks as if it is from the school, asking the teacher to re-enter login details through a link',
          'a parent asking for class activity photos to be posted on a public page',
          'a worksheet that loses its formatting when opened on the school computer',
        ],
        school: [
          'a colleague asking for the examination marks spreadsheet over a personal messaging app',
          'a phishing email asking for login credentials',
          'a student asking for classroom photos to be shared on public social media',
        ],
        senior: [
          'hundreds of files built up over the years (lesson plans, question papers, answer keys, records) that must stay easy to find',
          'several versions of a question paper edited by different teachers',
          'internal assessment records kept only on a personal laptop',
        ],
      },
      parts: [
        { marks: 4, purpose: 'Analyse the situation or situations: the warning signs, risks or causes the teacher should recognise.' },
        { marks: 3, purpose: 'The steps the teacher would take, in order, and why.' },
        { marks: 3, purpose: 'The right decisions or preventive practices for the other situations or for the future, with justification.' },
      ],
    },
    {
      purpose:
        'A teaching or school task the teacher must do with digital tools. Name the tools and resources available and the constraint (time, class size, a technical failure).',
      ideas: {
        early: [
          'choosing between an educational video, an interactive app and a presentation for a lesson',
          'the internet failing just before class, so the videos in a presentation will not load',
          'making a presentation that is clear and engaging for young children',
        ],
        school: [
          'analysing a class test in a spreadsheet to find learners who need remediation, and showing the Principal a visual summary',
          'choosing two of four digital resources (presentation, video, worksheet, images) for a 40-minute lesson',
          'sending a final worksheet to the office for printing without any change to its formatting',
        ],
        senior: [
          'finding performance trends in the marks of 600 students across several assessments',
          'automating repetitive work such as attendance, mark sheets and reports',
          'keeping formatting consistent across a long record document',
        ],
      },
      parts: [
        { marks: 3, purpose: 'Which tool, resource or feature the teacher would choose, and why.' },
        { marks: 3, purpose: 'How the teacher would use it step by step, or at which stage of the lesson.' },
        { marks: 2, purpose: 'How to keep learners active, or the work accurate and consistent, while using it.' },
        { marks: 2, purpose: 'How the teacher would present, share or follow up on the result.' },
      ],
    },
    {
      purpose: 'The teacher uses AI tools and online sources to prepare teaching material. Say what the AI produced or which sources were used.',
      ideas: {
        early: ['an AI tool that wrote a story, a rhyme and activity ideas for a class', 'images and videos found online for a lesson'],
        school: [
          'an AI tool that generated an explanation, five assessment questions, model answers and a homework activity',
          'two websites that give conflicting information on the same topic',
        ],
        senior: [
          'notes for Classes 11 and 12 built from textbooks, journals, websites, videos and AI explanations',
          'AI-generated practice questions in a subject where conceptual accuracy is critical',
        ],
      },
      parts: [
        { marks: 3, purpose: 'How the teacher checks accuracy, reliability, age-appropriateness and fit with the curriculum.' },
        { marks: 3, purpose: 'How the teacher evaluates, improves or combines the material while staying responsible for its quality and respecting copyright and academic integrity.' },
        { marks: 4, purpose: 'A broader professional or ethical question, for example four tasks where AI can help teachers, each with a precaution, or four practices for safe and ethical use of technology in class.' },
      ],
    },
  ],
};

export const TEACHER_TYPES = {
  subject: 'Subject teacher',
  specialist: 'Specialist faculty (arts, music, dance, on-field PE)',
};

export const SECTION_KEYS = ['A', 'B', 'C'];

// The sections a paper can include, in paper order, for each teacher type.
export function sectionFormats(teacherType, keys) {
  const available = {
    A: SECTION_A,
    B: teacherType === 'specialist' ? SECTION_B_SPECIALIST : SECTION_B_SUBJECT,
    C: SECTION_C,
  };
  return SECTION_KEYS.filter((key) => keys.includes(key)).map((key) => available[key]);
}

export function sectionMarks(format) {
  return format.questions.reduce((sum, question) => sum + questionMarks(question), 0);
}

export function questionMarks(question) {
  return question.parts.reduce((sum, part) => sum + part.marks, 0);
}

// Each section keeps its own numbers whichever others are included, as the
// sample papers do (an A and C paper runs Q1-Q4, then Q9-Q11). The one
// exception is a specialist paper that is only Section B, which starts at Q1.
export function firstQuestionNumber(formats, index, teacherType) {
  const format = formats[index];
  if (format.key === 'B' && teacherType === 'specialist' && formats.length === 1) return 1;
  return format.start;
}

export function partLabel(question, index) {
  return question.components ? String(index + 1) : String.fromCharCode(65 + index);
}

// The school levels papers are written for. `guidance` tells Gemini who the
// teacher's learners are, so scenarios, content depth and psychology fit, and
// `group` picks the matching `ideas` in the sections above.
export const LEVELS = {
  'pre-primary': {
    name: 'Pre-Primary',
    classes: 'Nursery, LKG and UKG',
    group: 'early',
    guidance:
      'Learners are 3 to 6 years old. Teaching is play-based and multi-sensory: early literacy and numeracy readiness, oral language, fine and gross motor skills, rhymes, stories and routines. Psychology questions are about early childhood: separation anxiety, attachment, tantrums, attention span, sharing, learning through play. Assessment is by observation, not written tests. Subject knowledge means the early-years concept behind an activity (phonemic awareness, number sense, sorting and patterns), not textbook content.',
  },
  primary: {
    name: 'Primary',
    classes: 'Classes 1 to 5',
    group: 'early',
    guidance:
      'Learners are 6 to 11 years old. Teaching is concrete and activity-based, building foundational literacy and numeracy. Psychology questions are about middle childhood: confidence, peer comparison, reading or maths anxiety, attention, sharing and turn-taking, home-school habits.',
  },
  'middle-school': {
    name: 'Middle School',
    classes: 'Classes 6 to 8',
    group: 'school',
    guidance:
      'Learners are 11 to 14 years old, moving from concrete to abstract thinking. Subject content becomes more formal. Psychology questions are about early adolescence: identity, peer pressure, self-consciousness, motivation dips, screen habits.',
  },
  secondary: {
    name: 'Secondary',
    classes: 'Classes 9 and 10',
    group: 'school',
    guidance:
      'Learners are 14 to 16 years old and preparing for board examinations. Subject questions go to board-syllabus depth, including numerical, practical and application work. Psychology questions are about adolescence: exam stress, perfectionism, comparison, fear of failure, parental expectations.',
  },
  'senior-secondary': {
    name: 'Senior Secondary / PU',
    classes: 'Classes 11 and 12, I and II PUC',
    group: 'senior',
    guidance:
      'Learners are 16 to 18 years old in a specialised stream, preparing for board and entrance examinations. Subject questions must test the teacher at a rigorous, higher-secondary or pre-university level, with data, derivations, practicals or code where the subject has them. Psychology questions are about late adolescence: career and entrance pressure, burnout, autonomy, coaching-class overload.',
  },
};
