import { useEffect, useState } from 'react';
import { Trash2, Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api';

const emptyUni = { name: '', country_id: '', city: '', website: '' };
const emptyCourse = { name: '', level: 'Bachelors', duration_months: '', currency: 'USD', tuition_fee: '' };

export default function UniversitiesManager() {
  const [universities, setUniversities] = useState([]);
  const [countries, setCountries] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [courses, setCourses] = useState([]);
  const [showUniForm, setShowUniForm] = useState(false);
  const [uniForm, setUniForm] = useState(emptyUni);
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [courseForm, setCourseForm] = useState(emptyCourse);

  const loadUniversities = () => api.listUniversities().then(setUniversities);
  useEffect(() => { loadUniversities(); api.listCountries().then(setCountries); }, []);

  const toggleExpand = (uni) => {
    if (expanded === uni.id) { setExpanded(null); return; }
    setExpanded(uni.id);
    setShowCourseForm(false);
    api.listCourses(uni.id).then(setCourses);
  };

  const addUniversity = async (e) => {
    e.preventDefault();
    try {
      await api.createUniversity({ ...uniForm, country_id: uniForm.country_id || null });
      setUniForm(emptyUni);
      setShowUniForm(false);
      loadUniversities();
    } catch (err) { alert('Could not add: ' + err.message); }
  };

  const deleteUniversity = async (uni) => {
    if (!confirm(`Delete "${uni.name}"? This removes its courses too.`)) return;
    await api.deleteUniversity(uni.id);
    loadUniversities();
  };

  const addCourse = async (e) => {
    e.preventDefault();
    try {
      await api.createCourse({
        university_id: expanded, ...courseForm,
        duration_months: Number(courseForm.duration_months) || null,
        tuition_fee: Number(courseForm.tuition_fee) || null,
      });
      setCourseForm(emptyCourse);
      setShowCourseForm(false);
      api.listCourses(expanded).then(setCourses);
      loadUniversities();
    } catch (err) { alert('Could not add: ' + err.message); }
  };

  const deleteCourse = async (c) => {
    if (!confirm(`Delete "${c.name}"?`)) return;
    await api.deleteCourse(c.id);
    api.listCourses(expanded).then(setCourses);
    loadUniversities();
  };

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button onClick={() => setShowUniForm((s) => !s)}
          className="flex items-center gap-1.5 bg-ink text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-ink-light">
          <Plus className="w-4 h-4" /> {showUniForm ? 'Cancel' : 'Add university'}
        </button>
      </div>

      {showUniForm && (
        <form onSubmit={addUniversity} className="bg-white border border-line rounded-xl p-5 mb-4 grid grid-cols-2 gap-3">
          <input required placeholder="University name" className="border border-line rounded-lg px-3 py-2 text-sm col-span-2"
            value={uniForm.name} onChange={(e) => setUniForm({ ...uniForm, name: e.target.value })} />
          <select className="border border-line rounded-lg px-3 py-2 text-sm"
            value={uniForm.country_id} onChange={(e) => setUniForm({ ...uniForm, country_id: e.target.value })}>
            <option value="">Country…</option>
            {countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input placeholder="City" className="border border-line rounded-lg px-3 py-2 text-sm"
            value={uniForm.city} onChange={(e) => setUniForm({ ...uniForm, city: e.target.value })} />
          <input placeholder="Website" className="border border-line rounded-lg px-3 py-2 text-sm col-span-2"
            value={uniForm.website} onChange={(e) => setUniForm({ ...uniForm, website: e.target.value })} />
          <button type="submit" className="col-span-2 bg-amber text-white text-sm font-medium py-2 rounded-lg hover:opacity-90">
            Save university
          </button>
        </form>
      )}

      <div className="space-y-2">
        {universities.map((uni) => (
          <div key={uni.id} className="bg-white border border-line rounded-xl overflow-hidden">
            <div onClick={() => toggleExpand(uni)} className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-canvas/60">
              <div className="flex items-center gap-2 min-w-0">
                {expanded === uni.id ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink truncate">{uni.name}</div>
                  <div className="text-xs text-slate-400">{[uni.city, uni.country_name].filter(Boolean).join(', ') || 'Location not set'} · {uni.course_count} course{uni.course_count === 1 ? '' : 's'}</div>
                </div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); deleteUniversity(uni); }} className="text-slate-300 hover:text-warn shrink-0">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {expanded === uni.id && (
              <div className="border-t border-line px-4 py-3 bg-canvas/30">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Courses</span>
                  <button onClick={() => setShowCourseForm((s) => !s)} className="text-xs text-ink hover:underline">
                    {showCourseForm ? 'Cancel' : '+ Add course'}
                  </button>
                </div>

                {showCourseForm && (
                  <form onSubmit={addCourse} className="grid grid-cols-2 gap-2 mb-3 bg-white border border-line rounded-lg p-3">
                    <input required placeholder="Course name" className="border border-line rounded-lg px-2.5 py-1.5 text-xs col-span-2"
                      value={courseForm.name} onChange={(e) => setCourseForm({ ...courseForm, name: e.target.value })} />
                    <select className="border border-line rounded-lg px-2.5 py-1.5 text-xs"
                      value={courseForm.level} onChange={(e) => setCourseForm({ ...courseForm, level: e.target.value })}>
                      <option>Diploma</option><option>Bachelors</option><option>Masters</option><option>PhD</option>
                    </select>
                    <input type="number" placeholder="Duration (months)" className="border border-line rounded-lg px-2.5 py-1.5 text-xs"
                      value={courseForm.duration_months} onChange={(e) => setCourseForm({ ...courseForm, duration_months: e.target.value })} />
                    <input type="number" placeholder="Tuition fee" className="border border-line rounded-lg px-2.5 py-1.5 text-xs"
                      value={courseForm.tuition_fee} onChange={(e) => setCourseForm({ ...courseForm, tuition_fee: e.target.value })} />
                    <input placeholder="Currency" className="border border-line rounded-lg px-2.5 py-1.5 text-xs"
                      value={courseForm.currency} onChange={(e) => setCourseForm({ ...courseForm, currency: e.target.value })} />
                    <button type="submit" className="col-span-2 bg-amber text-white text-xs font-medium py-1.5 rounded-lg hover:opacity-90">
                      Save course
                    </button>
                  </form>
                )}

                {courses.map((c) => (
                  <div key={c.id} className="flex items-center justify-between py-1.5 text-xs border-b border-line/60 last:border-0">
                    <span className="text-ink">{c.name} <span className="text-slate-400">· {c.level} · {c.duration_months}mo</span></span>
                    <div className="flex items-center gap-3">
                      <span className="text-slate-500">{c.currency} {c.tuition_fee}</span>
                      <button onClick={() => deleteCourse(c)} className="text-slate-300 hover:text-warn"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                ))}
                {courses.length === 0 && <p className="text-xs text-slate-400 py-2">No courses added yet.</p>}
              </div>
            )}
          </div>
        ))}
        {universities.length === 0 && <p className="text-sm text-slate-400 text-center py-8">No universities yet.</p>}
      </div>
    </div>
  );
}
