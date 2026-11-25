const subjects = [
  {
    id: '1101', name: 'Art', layout: 'cards', categories: [['Studio Portfolio', 100]],
    tasks: [['Studio Portfolio', '<div class="assessment-score"><div data-rubric><span class="points">6 / 8</span></div></div>']],
    kinds: ['rubric'], grades: { percentage: null, points: null, absolute: null }
  },
  {
    id: '1139', name: 'Psychology', layout: 'cards', categories: [['Case Studies', 35], ['Research Methods', 65]],
    tasks: [
      ['Case Studies', '<div class="task-score"><span class="points">8 / 10</span></div>'],
      ['Case Studies', '<div class="assessment-score">12 out of 20 points</div>'],
      ['Research Methods', '<div class="assessment-score" data-earned-points="9" data-max-points="10"></div>']
    ],
    kinds: ['points', 'points', 'points'], grades: { percentage: 83, points: 81.83333333333333, absolute: 79.62962962962963 }
  },
  {
    id: '1072', name: 'English Literature', categories: [['Close Reading', 100]],
    tasks: [['Close Reading', '<span class="letter-grade">A−</span>']],
    kinds: ['letter'], grades: { percentage: null, points: null, absolute: null }
  },
  {
    id: '2641', name: 'Biology', layout: 'list', categories: [['Practical Reports', 100]],
    tasks: [
      ['Practical Reports', '<div class="assessment-score">17.5 out of 20 marks</div>'],
      ['Practical Reports', '<div class="assessment-score"><div data-rubric><span class="points">3 / 8</span></div><span class="score-points">35 / 40</span></div>']
    ],
    kinds: ['points', 'points'], grades: { percentage: 87.5, points: 87.5, absolute: 87.5 }
  },
  {
    id: '793', name: 'Business', categories: [['Case Presentation', 100]],
    tasks: [['Case Presentation', '<span data-earned-points="0" data-max-points="12"></span>']],
    kinds: ['points'], grades: { percentage: 0, points: 0, absolute: 0 }
  },
  {
    id: '508', name: 'English Language', categories: [['Oral Commentary', 100]],
    tasks: [['Oral Commentary', '<span data-earned-points="12"></span>']],
    kinds: ['invalid'], grades: { percentage: null, points: null, absolute: null }
  },
  {
    id: '3610', name: 'Further Mathematics', categories: [['Proofs and Problem Solving', 100]],
    tasks: [['Proofs and Problem Solving', '<span class="marks">47 / 50</span>']],
    kinds: ['points'], grades: { percentage: 94, points: 94, absolute: 94 }
  },
  {
    id: '2016', name: 'Design & Technology', layout: 'list', categories: [['Prototyping', 100]],
    tasks: [['Prototyping', '<span class="submission-status">Pending</span>']],
    kinds: ['ungraded'], grades: { percentage: null, points: null, absolute: null }
  }
];

const html = (value) => value.replaceAll('&', '&amp;');
const tasksPath = ({ id }) => '/student/classes/' + id + '/core_tasks';

function page(content) {
  return `<!doctype html><html><head><meta name="current-student-id" content="81"></head><body>
    <nav><a href="/student/tasks_and_deadlines">Tasks &amp; Deadlines</a><a href="/student/classes">My Classes</a></nav>
    <main>${content}</main></body></html>`;
}

function tasksPage(subject) {
  const { name, tasks, categories } = subject;
  const term = 'term-' + subject.id;
  const rows = tasks.map(([category, score], index) => {
    const link = `<a href="${tasksPath(subject)}/${index + 1}">Assessment ${index + 1}</a>`;
    if (subject.layout === 'cards') {
      return `<article class="assessment-card">${link}<span data-category-display class="task-category">${html(category)}</span>${score}</article>`;
    }
    if (subject.layout === 'list') {
      return `<li data-assessment-id="${index + 1}">${link}<span class="assessment-category">${html(category)}</span>${score}</li>`;
    }
    return `<tr><th>${link}</th><td class="assessment-category">${html(category)}</td><td>${score}</td></tr>`;
  }).join('');
  const list = `data-task-list="all" data-term-id="${term}" data-total-count="${tasks.length}"`;
  const taskList = subject.layout === 'cards' ? `<div ${list}>${rows}</div>` :
    subject.layout === 'list' ? `<ul ${list}>${rows}</ul>` : `<table ${list}><tbody>${rows}</tbody></table>`;
  return page(`<h1 class="class-title">${html(name)}</h1>
    <section data-all-tasks><h2>All Tasks</h2><select name="term_id"><option value="${term}" selected>Semester 1</option></select>
    <div><h3>Assessment</h3><canvas></canvas></div>
    ${taskList}</section>
    <table><thead><tr><th>Category</th><th>Weight (%)</th></tr></thead><tbody>
    ${categories.map(([name, weight]) => `<tr><td>${html(name)}</td><td>${weight}%</td></tr>`).join('')}
    </tbody></table>`);
}

function rosterPage() {
  return page(subjects.map(({ id, name }) => `<a href="/student/classes/${id}">${html(name)}</a>`).join(''));
}

module.exports = { subjects, page, tasksPath, tasksPage, rosterPage };
