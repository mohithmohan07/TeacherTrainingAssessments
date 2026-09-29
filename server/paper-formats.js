// The layout of the teacher assessment papers the generator writes, taken from
// the programme's sample papers: each section is 35 marks for one hour, made of
// four case-study questions with lettered parts and fixed marks per part.
//
// `purpose` tells Gemini what each question and part must test. It describes
// the pattern of the sample papers in our own words; no sample text is copied.

export const SECTION_MINUTES = 60;

const SECTION_A = {
  key: 'A',
  heading: 'Section A - Interpersonal & Instructional Communication Skills',
  focus: 'how the teacher communicates with students, parents and colleagues, and in writing',
  questions: [
    {
      title: 'Student & Parent Communication',
      purpose:
        'A named young learner shows a difficulty (anxiety, a learning gap or behaviour) and a parent arrives upset, blaming the school. Describe both sides concretely.',
      parts: [
        { marks: 3, purpose: 'How the teacher speaks directly to the learner to reassure and encourage without criticism.' },
        { marks: 3, purpose: 'How the teacher handles a structured meeting with the parent: empathy plus a clear explanation of expectations.' },
        { marks: 2, purpose: 'Which observation-based evidence and professional boundaries keep the discussion objective, fair and confidential.' },
        { marks: 2, purpose: 'A short, practical home-school follow-up and monitoring plan over a stated number of weeks.' },
      ],
    },
    {
      title: 'Instructional Classroom Communication',
      purpose: 'The teacher introduces a hands-on, multi-step activity suited to the grade, done in pairs or groups. Name the activity and its materials.',
      parts: [
        { marks: 2, purpose: 'Giving clear, step-by-step oral instructions with language and visual cues suited to the age group.' },
        { marks: 2, purpose: 'Checking understanding before work starts without asking "Do you understand?".' },
        { marks: 2, purpose: 'Supporting a shy learner or a learner still learning the language of instruction so they take part fully.' },
        { marks: 2, purpose: 'A short lesson closure that shows whether the learning outcomes were met across the class.' },
      ],
    },
    {
      title: 'Professional Collaboration & Communication',
      purpose: 'The teacher notices a pattern affecting several learners and calls a meeting with named roles (coordinator, counsellor, support staff).',
      parts: [
        { marks: 2, purpose: 'Sharing observations and concerns respectfully, without blaming colleagues or parents.' },
        { marks: 2, purpose: 'Resolving differences of opinion about responsibilities while keeping student information confidential.' },
        { marks: 3, purpose: 'A coordinated intervention plan over a stated period and how it will improve learner well-being and readiness.' },
      ],
    },
    {
      title: 'Formal Professional Report',
      purpose:
        'A trend is observed across classes during a review (for example a learning gap that frustrates learners and worries parents). The teacher must draft a formal, structured report to the Principal containing the five components listed as parts.',
      components: true,
      parts: [
        { marks: 2, purpose: 'Summary of Concern: a clear description of the gap observed.' },
        { marks: 2, purpose: 'Relevant Evidence: classroom observations, assessment samples, teacher and parent feedback.' },
        { marks: 2, purpose: 'Analysis of Possible Causes, with examples of likely causes.' },
        { marks: 2, purpose: 'Practical Recommendations: three actionable, low-cost strategies.' },
        { marks: 2, purpose: 'Monitoring Plan & Review Timeline, with measurable indicators and a review period.' },
      ],
    },
  ],
};

const SECTION_B_SUBJECT = {
  key: 'B',
  heading: 'Section B - Knowledge Proficiency, Classroom Management & Child Psychology',
  focus: 'the teacher\'s own subject knowledge, how they teach and assess it, how they manage the class, and child or adolescent psychology',
  questions: [
    {
      purpose:
        'A specific topic from the syllabus, with the concrete errors or misconceptions learners at this level show (quote what learners wrongly say or write).',
      parts: [
        { marks: 4, purpose: 'Explain the concept accurately at teacher level and correct the misconception, with examples.' },
        { marks: 3, purpose: 'Analyse why learners of this age struggle with it and outline one concrete activity that addresses it.' },
        { marks: 3, purpose: 'Design a short diagnostic task (e.g. predict-observe-explain) that tests application rather than recall.' },
      ],
    },
    {
      purpose: 'Introducing another topic that learners find abstract or hard to connect to something concrete.',
      parts: [
        { marks: 3, purpose: 'An interactive, activity-based teaching strategy that makes the idea visible or hands-on.' },
        { marks: 3, purpose: 'Two quick formative assessment techniques to check understanding during the lesson.' },
        { marks: 2, purpose: 'A differentiated activity that supports struggling learners and stretches advanced ones.' },
      ],
    },
    {
      purpose:
        'A realistic classroom, lab, field or practical session where several management or safety problems happen at once. List them concretely.',
      parts: [
        { marks: 4, purpose: 'Analyse the situation and give two immediate, non-confrontational actions to restore order, safety and fair access.' },
        { marks: 3, purpose: 'Two long-term preventive routines or roles that keep the session orderly.' },
        { marks: 2, purpose: 'Ensuring individual accountability and communicating the standards to parents.' },
      ],
    },
    {
      purpose:
        'A named learner of a stated age with a subject-specific psychological difficulty (anxiety, perfectionism, peer comparison, withdrawal). Describe the behaviour in detail.',
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

export const TEACHER_TYPES = {
  subject: 'Subject teacher',
  specialist: 'Specialist faculty (arts, music, dance, on-field PE)',
};

// The sections a paper can include, in paper order, for each teacher type.
export function sectionFormats(teacherType, keys) {
  const available = { A: SECTION_A, B: teacherType === 'specialist' ? SECTION_B_SPECIALIST : SECTION_B_SUBJECT };
  return ['A', 'B'].filter((key) => keys.includes(key)).map((key) => available[key]);
}

export function sectionMarks(format) {
  return format.questions.reduce((sum, question) => sum + questionMarks(question), 0);
}

export function questionMarks(question) {
  return question.parts.reduce((sum, part) => sum + part.marks, 0);
}

// Section B papers number their questions from Q5, after Section A's four,
// except the specialist papers, which only ever have Section B and start at Q1.
export function firstQuestionNumber(formats, index, teacherType) {
  if (index > 0) return formats.slice(0, index).reduce((sum, format) => sum + format.questions.length, 1);
  if (formats[0].key === 'B' && teacherType !== 'specialist') return 5;
  return 1;
}

export function partLabel(question, index) {
  return question.components ? String(index + 1) : String.fromCharCode(65 + index);
}
