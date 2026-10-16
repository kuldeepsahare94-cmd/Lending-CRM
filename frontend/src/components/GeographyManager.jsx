import { useEffect, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { api } from '../api';

// Hoisted OUTSIDE GeographyManager on purpose: defining a component inside
// another component's render body creates a brand-new function reference
// every re-render, which makes React treat it as a different component type
// and remount the whole subtree — including input fields, which lose focus
// after every keystroke. Keeping it top-level fixes that.
function Column({ title, items, selected, onSelect, onAdd, addValue, setAddValue, onDelete, empty, disabled }) {
  return (
    <div className="flex-1 min-w-0">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{title}</h3>
      {!disabled && (
        <form onSubmit={onAdd} className="flex gap-1.5 mb-2">
          <input value={addValue} onChange={(e) => setAddValue(e.target.value)} placeholder="Add…"
            className="border border-line rounded-lg px-2.5 py-1.5 text-xs flex-1 min-w-0" />
          <button type="submit" className="bg-ink text-white p-1.5 rounded-lg shrink-0"><Plus className="w-3.5 h-3.5" /></button>
        </form>
      )}
      <div className="bg-white border border-line rounded-xl overflow-hidden max-h-80 overflow-y-auto">
        {items.map((item) => (
          <div key={item.id}
            onClick={() => onSelect && onSelect(item)}
            className={`px-3 py-2 text-sm flex items-center justify-between border-b border-line/60 last:border-0 ${
              onSelect ? 'cursor-pointer' : ''
            } ${selected?.id === item.id ? 'bg-amber-soft text-ink font-medium' : 'text-ink hover:bg-canvas'}`}>
            <span className="truncate">{item.name}</span>
            <button onClick={(e) => { e.stopPropagation(); onDelete(item); }} className="text-slate-300 hover:text-warn shrink-0 ml-2">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        {items.length === 0 && <div className="px-3 py-6 text-center text-slate-400 text-xs">{empty}</div>}
      </div>
    </div>
  );
}

export default function GeographyManager() {
  const [countries, setCountries] = useState([]);
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [states, setStates] = useState([]);
  const [selectedState, setSelectedState] = useState(null);
  const [cities, setCities] = useState([]);

  const [newCountry, setNewCountry] = useState('');
  const [newState, setNewState] = useState('');
  const [newCity, setNewCity] = useState('');

  const loadCountries = () => api.listCountries().then(setCountries);
  useEffect(() => { loadCountries(); }, []);

  useEffect(() => {
    if (selectedCountry) api.listStates(selectedCountry.id).then(setStates);
    else setStates([]);
    setSelectedState(null);
    setCities([]);
  }, [selectedCountry]);

  useEffect(() => {
    if (selectedState) api.listCities(selectedState.id).then(setCities);
    else setCities([]);
  }, [selectedState]);

  const addCountry = async (e) => {
    e.preventDefault();
    if (!newCountry.trim()) return;
    try {
      await api.createCountry({ name: newCountry.trim() });
      setNewCountry('');
      loadCountries();
    } catch (err) { alert(err.message); }
  };

  const addState = async (e) => {
    e.preventDefault();
    if (!newState.trim() || !selectedCountry) return;
    await api.createState({ country_id: selectedCountry.id, name: newState.trim() });
    setNewState('');
    api.listStates(selectedCountry.id).then(setStates);
  };

  const addCity = async (e) => {
    e.preventDefault();
    if (!newCity.trim() || !selectedState) return;
    await api.createCity({ state_id: selectedState.id, name: newCity.trim() });
    setNewCity('');
    api.listCities(selectedState.id).then(setCities);
  };

  const deleteCountry = async (c) => {
    if (!confirm(`Delete "${c.name}"? This removes its states and cities too.`)) return;
    await api.deleteCountry(c.id);
    if (selectedCountry?.id === c.id) setSelectedCountry(null);
    loadCountries();
  };
  const deleteState = async (s) => {
    if (!confirm(`Delete "${s.name}"? This removes its cities too.`)) return;
    await api.deleteState(s.id);
    if (selectedState?.id === s.id) setSelectedState(null);
    api.listStates(selectedCountry.id).then(setStates);
  };
  const deleteCity = async (c) => {
    if (!confirm(`Delete "${c.name}"?`)) return;
    await api.deleteCity(c.id);
    api.listCities(selectedState.id).then(setCities);
  };

  return (
    <div className="flex gap-4">
      <Column title="Countries" items={countries} selected={selectedCountry} onSelect={setSelectedCountry}
        onAdd={addCountry} addValue={newCountry} setAddValue={setNewCountry} onDelete={deleteCountry}
        empty="No countries yet." />
      <Column title="States" items={states} selected={selectedState} onSelect={setSelectedState}
        onAdd={addState} addValue={newState} setAddValue={setNewState} onDelete={deleteState}
        empty={selectedCountry ? 'No states yet.' : 'Select a country first'} disabled={!selectedCountry} />
      <Column title="Cities" items={cities} onAdd={addCity} addValue={newCity} setAddValue={setNewCity}
        onDelete={deleteCity} empty={selectedState ? 'No cities yet.' : 'Select a state first'} disabled={!selectedState} />
    </div>
  );
}
