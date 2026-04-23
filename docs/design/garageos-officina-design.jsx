import { useState } from 'react';
import { Search, Plus, Calendar, Wrench, ChevronRight, ChevronDown, Clock, MapPin, User, Car, AlertTriangle, CheckCircle2, Edit3, Paperclip, History, Settings, LogOut, Home, Users, Bell, FileText, QrCode, Printer, X, Filter, MoreHorizontal, Menu, ArrowLeft } from 'lucide-react';

export default function GarageOSOfficinaDesign() {
  const [currentView, setCurrentView] = useState('designsystem');

  const views = [
    { id: 'designsystem', label: 'Design System' },
    { id: 'dashboard', label: 'Dashboard Home' },
    { id: 'vehicle', label: 'Scheda Veicolo' },
    { id: 'newintervention', label: 'Nuovo Intervento' },
  ];

  return (
    <div className="min-h-screen bg-slate-50" style={{ fontFamily: "'Manrope', -apple-system, sans-serif" }}>
      {/* Load fonts */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');

        :root {
          --go-blue-50: #eff6ff;
          --go-blue-100: #dbeafe;
          --go-blue-500: #3b82f6;
          --go-blue-600: #2563eb;
          --go-blue-700: #1d4ed8;
          --go-blue-900: #1e3a8a;
        }

        .font-mono { font-family: 'JetBrains Mono', monospace; }

        .garage-code {
          font-family: 'JetBrains Mono', monospace;
          letter-spacing: 0.05em;
        }
      `}</style>

      {/* Top selector bar */}
      <div className="bg-slate-900 text-white px-6 py-3 border-b border-slate-800 sticky top-0 z-50">
        <div className="flex items-center justify-between max-w-[1600px] mx-auto">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center font-bold">G</div>
            <div className="font-bold text-lg tracking-tight">GarageOS <span className="text-slate-400 font-normal">— Web Officina Design</span></div>
          </div>
          <div className="flex gap-1 bg-slate-800 p-1 rounded-lg">
            {views.map(v => (
              <button
                key={v.id}
                onClick={() => setCurrentView(v.id)}
                className={`px-3 py-1.5 text-sm rounded-md transition ${
                  currentView === v.id ? 'bg-white text-slate-900 font-medium' : 'text-slate-400 hover:text-white'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto">
        {currentView === 'designsystem' && <DesignSystem />}
        {currentView === 'dashboard' && <Dashboard />}
        {currentView === 'vehicle' && <VehicleDetail />}
        {currentView === 'newintervention' && <NewIntervention />}
      </div>
    </div>
  );
}

function DesignSystem() {
  return (
    <div className="p-8 space-y-12">
      <div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2 tracking-tight">Design System — Web Officina</h1>
        <p className="text-slate-600">Lingua visiva del sistema B2B. Denso, tecnico, professionale.</p>
      </div>

      {/* Colors */}
      <section>
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">Palette colori</h2>
        <div className="grid grid-cols-6 gap-3">
          {[
            { name: 'Blue 50', hex: '#eff6ff', bg: 'bg-blue-50' },
            { name: 'Blue 100', hex: '#dbeafe', bg: 'bg-blue-100' },
            { name: 'Blue 500', hex: '#3b82f6', bg: 'bg-blue-500' },
            { name: 'Blue 600', hex: '#2563eb', bg: 'bg-blue-600' },
            { name: 'Blue 700', hex: '#1d4ed8', bg: 'bg-blue-700' },
            { name: 'Blue 900', hex: '#1e3a8a', bg: 'bg-blue-900' },
          ].map(c => (
            <div key={c.name} className="space-y-2">
              <div className={`${c.bg} h-16 rounded-lg border border-slate-200`}></div>
              <div className="text-xs font-medium text-slate-900">{c.name}</div>
              <div className="text-xs font-mono text-slate-500">{c.hex}</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-6 gap-3 mt-3">
          {[
            { name: 'Slate 50', hex: '#f8fafc', bg: 'bg-slate-50' },
            { name: 'Slate 200', hex: '#e2e8f0', bg: 'bg-slate-200' },
            { name: 'Slate 500', hex: '#64748b', bg: 'bg-slate-500' },
            { name: 'Slate 900', hex: '#0f172a', bg: 'bg-slate-900' },
            { name: 'Emerald 600', hex: '#059669', bg: 'bg-emerald-600' },
            { name: 'Amber 500', hex: '#f59e0b', bg: 'bg-amber-500' },
          ].map(c => (
            <div key={c.name} className="space-y-2">
              <div className={`${c.bg} h-16 rounded-lg border border-slate-200`}></div>
              <div className="text-xs font-medium text-slate-900">{c.name}</div>
              <div className="text-xs font-mono text-slate-500">{c.hex}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Typography */}
      <section>
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">Tipografia</h2>
        <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-4">
          <div>
            <div className="text-xs text-slate-500 mb-1">Display / H1 — Manrope 800, 48px</div>
            <div className="text-5xl font-extrabold tracking-tight text-slate-900">Interventi di oggi</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 mb-1">H2 — Manrope 700, 32px</div>
            <div className="text-3xl font-bold text-slate-900">Tagliando Fiat Panda</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 mb-1">H3 — Manrope 600, 20px</div>
            <div className="text-xl font-semibold text-slate-900">Scadenze in arrivo</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 mb-1">Body — Manrope 400, 14px</div>
            <div className="text-sm text-slate-700">Sostituzione olio motore 5W30, filtro olio, filtro aria e filtro abitacolo.</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 mb-1">Code / Mono — JetBrains Mono 600</div>
            <div className="font-mono font-semibold text-slate-900">GO-482-KXRT</div>
          </div>
        </div>
      </section>

      {/* Components */}
      <section>
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">Componenti base</h2>

        <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-8">
          {/* Buttons */}
          <div>
            <div className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-3">Pulsanti</div>
            <div className="flex gap-3 flex-wrap">
              <button className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition">Primario</button>
              <button className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-900 text-sm font-medium rounded-lg transition">Secondario</button>
              <button className="px-4 py-2 text-blue-600 hover:bg-blue-50 text-sm font-medium rounded-lg transition">Ghost</button>
              <button className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition">Distruttivo</button>
              <button className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition inline-flex items-center gap-2"><Plus size={16} /> Con icona</button>
            </div>
          </div>

          {/* Badges / Status */}
          <div>
            <div className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-3">Badge & Stati</div>
            <div className="flex gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-emerald-50 text-emerald-700 text-xs font-medium rounded-md border border-emerald-200">
                <CheckCircle2 size={12} /> Certificato
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-amber-50 text-amber-700 text-xs font-medium rounded-md border border-amber-200">
                <Clock size={12} /> Pendente
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-red-50 text-red-700 text-xs font-medium rounded-md border border-red-200">
                <AlertTriangle size={12} /> Contestato
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-blue-50 text-blue-700 text-xs font-medium rounded-md border border-blue-200">
                Nuovo
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-slate-100 text-slate-700 text-xs font-medium rounded-md border border-slate-200">
                Annullato
              </span>
            </div>
          </div>

          {/* Input */}
          <div>
            <div className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-3">Input</div>
            <div className="grid grid-cols-2 gap-4 max-w-2xl">
              <div>
                <label className="text-xs font-medium text-slate-700 block mb-1.5">Targa</label>
                <input type="text" defaultValue="AB123CD" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-700 block mb-1.5">Codice GarageOS</label>
                <input type="text" defaultValue="GO-482-KXRT" className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg bg-slate-50" disabled />
              </div>
            </div>
          </div>

          {/* Principles */}
          <div className="pt-4 border-t border-slate-200">
            <div className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-3">Principi di design</div>
            <ul className="text-sm text-slate-700 space-y-2">
              <li className="flex gap-2"><span className="text-blue-600 font-bold">·</span> <span><strong>Densità informativa</strong>: il banco accettazione ha ampi monitor e il meccanico vuole vedere molti dati insieme</span></li>
              <li className="flex gap-2"><span className="text-blue-600 font-bold">·</span> <span><strong>Azioni rapide</strong>: tutte le operazioni frequenti accessibili in ≤2 click dalla home</span></li>
              <li className="flex gap-2"><span className="text-blue-600 font-bold">·</span> <span><strong>Codici monospace</strong>: garage_code, VIN, targa sempre in font mono per leggibilità</span></li>
              <li className="flex gap-2"><span className="text-blue-600 font-bold">·</span> <span><strong>Stati visivi chiari</strong>: badge colorati standardizzati per certificato/pendente/contestato</span></li>
              <li className="flex gap-2"><span className="text-blue-600 font-bold">·</span> <span><strong>Layout dense ma respirato</strong>: padding generoso dentro card, spaziature controllate tra sezioni</span></li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

function Sidebar({ active }) {
  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: Home },
    { id: 'vehicles', label: 'Veicoli', icon: Car },
    { id: 'customers', label: 'Clienti', icon: Users },
    { id: 'interventions', label: 'Interventi', icon: Wrench },
    { id: 'deadlines', label: 'Scadenze', icon: Calendar },
    { id: 'notifications', label: 'Notifiche', icon: Bell },
    { id: 'reports', label: 'Report', icon: FileText },
  ];

  return (
    <aside className="w-60 bg-white border-r border-slate-200 h-[calc(100vh-56px)] sticky top-[56px] flex flex-col">
      <div className="p-4 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-md flex items-center justify-center text-white font-bold">G</div>
          <div>
            <div className="font-bold text-sm text-slate-900">Officina Rossi</div>
            <div className="text-xs text-slate-500">Milano Centro</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {items.map(item => {
          const Icon = item.icon;
          return (
            <a
              key={item.id}
              href="#"
              className={`flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition ${
                active === item.id
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <Icon size={16} />
              {item.label}
            </a>
          );
        })}
      </nav>

      <div className="p-3 border-t border-slate-200">
        <div className="flex items-center gap-3 p-2 hover:bg-slate-100 rounded-lg cursor-pointer">
          <div className="w-8 h-8 bg-slate-200 rounded-full flex items-center justify-center text-slate-600 text-sm font-semibold">GR</div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-slate-900 truncate">Giuseppe Rossi</div>
            <div className="text-xs text-slate-500">Super Admin</div>
          </div>
          <ChevronRight size={14} className="text-slate-400" />
        </div>
      </div>
    </aside>
  );
}

function TopBar({ title, children }) {
  return (
    <div className="bg-white border-b border-slate-200 px-8 py-4 sticky top-[56px] z-40">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        <div className="flex items-center gap-3 flex-1 max-w-2xl">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Cerca per targa, codice GO-..., cliente..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function Dashboard() {
  return (
    <div className="flex">
      <Sidebar active="dashboard" />

      <div className="flex-1">
        <TopBar title="Dashboard">
          <button className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition inline-flex items-center gap-2 whitespace-nowrap">
            <Plus size={16} /> Nuovo intervento
          </button>
        </TopBar>

        <div className="p-8 space-y-6">
          {/* Greeting */}
          <div>
            <div className="text-sm text-slate-500">Martedì 21 aprile · Officina Rossi — Milano Centro</div>
            <div className="text-2xl font-bold text-slate-900 mt-1">Buongiorno Giuseppe 👋</div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: 'Interventi oggi', value: '7', trend: '+2 vs ieri', color: 'text-blue-700', bg: 'bg-blue-50' },
              { label: 'Scadenze in arrivo', value: '23', trend: 'prossimi 30gg', color: 'text-amber-700', bg: 'bg-amber-50' },
              { label: 'Veicoli totali', value: '412', trend: '+8 questo mese', color: 'text-emerald-700', bg: 'bg-emerald-50' },
              { label: 'Contestazioni aperte', value: '1', trend: 'da gestire', color: 'text-red-700', bg: 'bg-red-50' },
            ].map(s => (
              <div key={s.label} className={`${s.bg} border border-slate-200 rounded-xl p-5`}>
                <div className="text-xs font-medium text-slate-600 uppercase tracking-wider">{s.label}</div>
                <div className={`text-3xl font-bold mt-2 ${s.color}`}>{s.value}</div>
                <div className="text-xs text-slate-500 mt-1">{s.trend}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-6">
            {/* Scadenze */}
            <div className="col-span-2 bg-white border border-slate-200 rounded-xl">
              <div className="p-5 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">Scadenze questa settimana</h3>
                  <p className="text-sm text-slate-500">Clienti da ricontattare</p>
                </div>
                <button className="text-sm text-blue-600 hover:text-blue-700 font-medium">Vedi tutte →</button>
              </div>
              <div className="divide-y divide-slate-100">
                {[
                  { date: '22 Apr', day: 'Domani', customer: 'Mario Rossi', vehicle: 'Fiat Panda 2021', plate: 'AB123CD', code: 'GO-482-KXRT', type: 'Tagliando', urgent: true },
                  { date: '24 Apr', day: 'Giovedì', customer: 'Anna Bianchi', vehicle: 'VW Golf 2019', plate: 'CD789EF', code: 'GO-288-QPWZ', type: 'Revisione', urgent: true },
                  { date: '25 Apr', day: 'Venerdì', customer: 'Luca Ferrari', vehicle: 'Ford Fiesta 2020', plate: 'GH456IJ', code: 'GO-154-BXNM', type: 'Cambio gomme', urgent: false },
                  { date: '26 Apr', day: 'Sabato', customer: 'Chiara Verdi', vehicle: 'Toyota Yaris 2022', plate: 'KL012MN', code: 'GO-709-WPXH', type: 'Tagliando', urgent: false },
                ].map((s, i) => (
                  <div key={i} className="p-4 hover:bg-slate-50 cursor-pointer transition flex items-center gap-4">
                    <div className={`w-16 text-center rounded-lg py-2 ${s.urgent ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-700'}`}>
                      <div className="text-xs font-medium">{s.day}</div>
                      <div className="text-sm font-bold">{s.date.split(' ')[0]}</div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-900">{s.customer}</span>
                        <span className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">{s.type}</span>
                      </div>
                      <div className="text-sm text-slate-600 mt-0.5">
                        {s.vehicle} · <span className="font-mono text-xs">{s.plate}</span> · <span className="font-mono text-xs text-blue-600">{s.code}</span>
                      </div>
                    </div>
                    <button className="text-slate-400 hover:text-slate-600">
                      <ChevronRight size={18} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Sidebar widgets */}
            <div className="space-y-6">
              {/* Ultimi interventi */}
              <div className="bg-white border border-slate-200 rounded-xl">
                <div className="p-5 border-b border-slate-200">
                  <h3 className="text-lg font-semibold text-slate-900">Interventi recenti</h3>
                </div>
                <div className="divide-y divide-slate-100">
                  {[
                    { time: '14:32', type: 'Tagliando', vehicle: 'Fiat Panda', plate: 'AB123CD' },
                    { time: '11:15', type: 'Cambio gomme', vehicle: 'Opel Corsa', plate: 'XY890ZW' },
                    { time: '09:45', type: 'Revisione', vehicle: 'Peugeot 208', plate: 'QR234ST' },
                  ].map((i, idx) => (
                    <div key={idx} className="p-3 hover:bg-slate-50 cursor-pointer">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-slate-500">{i.time}</span>
                        <span className="text-xs bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded font-medium border border-emerald-200">{i.type}</span>
                      </div>
                      <div className="text-sm font-medium text-slate-900 mt-1">{i.vehicle}</div>
                      <div className="text-xs font-mono text-slate-500">{i.plate}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Contestazione */}
              <div className="bg-gradient-to-br from-red-50 to-amber-50 border border-red-200 rounded-xl p-5">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center text-red-600 flex-shrink-0">
                    <AlertTriangle size={16} />
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900 text-sm">Contestazione da gestire</div>
                    <div className="text-xs text-slate-700 mt-1">Un cliente ha contestato un intervento di ieri. Risposta richiesta entro 14 giorni.</div>
                    <button className="mt-3 text-xs font-medium text-red-700 hover:text-red-800">Vedi contestazione →</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function VehicleDetail() {
  return (
    <div className="flex">
      <Sidebar active="vehicles" />

      <div className="flex-1">
        <TopBar title="">
          <button className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition inline-flex items-center gap-2 whitespace-nowrap">
            <Plus size={16} /> Nuovo intervento
          </button>
        </TopBar>

        <div className="px-8 pt-4">
          <div className="flex items-center gap-2 text-sm text-slate-600 mb-4">
            <a href="#" className="hover:text-slate-900">Veicoli</a>
            <ChevronRight size={14} />
            <span className="text-slate-900 font-mono">GO-482-KXRT</span>
          </div>
        </div>

        <div className="p-8 pt-0">
          {/* Vehicle header card */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-6">
            <div className="p-6 bg-gradient-to-r from-slate-900 to-slate-800 text-white">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm text-slate-300 mb-2">
                    <Car size={14} /> Autoveicolo · Benzina
                  </div>
                  <div className="text-3xl font-bold tracking-tight">Fiat Panda 1.2 Lounge</div>
                  <div className="text-slate-300 text-sm mt-1">Anno 2021 · Bianco Gelato · 1.242 cc · 51 kW</div>
                </div>
                <div className="flex gap-2">
                  <button className="px-3 py-2 bg-white/10 hover:bg-white/20 backdrop-blur text-sm rounded-lg transition inline-flex items-center gap-2">
                    <Printer size={14} /> Ristampa tag
                  </button>
                  <button className="px-3 py-2 bg-white/10 hover:bg-white/20 backdrop-blur text-sm rounded-lg transition inline-flex items-center gap-2">
                    <QrCode size={14} /> Mostra QR
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-6 mt-6 pt-6 border-t border-white/10">
                <div>
                  <div className="text-xs text-slate-400 uppercase tracking-wider">Codice GarageOS</div>
                  <div className="font-mono text-lg font-bold mt-1 text-blue-300">GO-482-KXRT</div>
                </div>
                <div>
                  <div className="text-xs text-slate-400 uppercase tracking-wider">Targa</div>
                  <div className="font-mono text-lg font-bold mt-1">AB 123 CD</div>
                </div>
                <div>
                  <div className="text-xs text-slate-400 uppercase tracking-wider">Telaio (VIN)</div>
                  <div className="font-mono text-sm mt-1 text-slate-300">ZFA16900000512345</div>
                </div>
                <div>
                  <div className="text-xs text-slate-400 uppercase tracking-wider">Km attuali</div>
                  <div className="text-lg font-bold mt-1">45.000 <span className="text-sm text-slate-400">km</span></div>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 bg-slate-50 flex items-center justify-between border-b border-slate-200">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <User size={16} className="text-slate-400" />
                  <div>
                    <div className="text-xs text-slate-500">Proprietario</div>
                    <div className="text-sm font-medium text-slate-900">Mario Rossi</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <MapPin size={16} className="text-slate-400" />
                  <div>
                    <div className="text-xs text-slate-500">Immatricolato</div>
                    <div className="text-sm font-medium text-slate-900">15 Marzo 2021</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600" />
                  <div>
                    <div className="text-xs text-slate-500">Stato</div>
                    <div className="text-sm font-medium text-emerald-700">Certificato</div>
                  </div>
                </div>
              </div>
              <button className="text-sm text-blue-600 hover:text-blue-700 font-medium">Modifica dati</button>
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-slate-200 mb-6">
            <div className="flex gap-6">
              {['Storico interventi', 'Scadenze (2)', 'Audit accessi', 'Note interne'].map((t, i) => (
                <button
                  key={t}
                  className={`pb-3 text-sm font-medium border-b-2 transition ${
                    i === 0 ? 'text-blue-700 border-blue-600' : 'text-slate-600 border-transparent hover:text-slate-900'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Timeline */}
          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2">
              <div className="space-y-3">
                {[
                  {
                    date: '21 Apr 2026', km: '45.000', type: 'TAGLIANDO', title: 'Tagliando completo',
                    description: 'Sostituzione olio motore 5W30, filtro olio, filtro aria, filtro abitacolo. Controllo livelli e usura pastiglie freni. Rotazione pneumatici.',
                    parts: ['Olio motore 5W30', 'Filtro olio', 'Filtro aria', 'Filtro abitacolo'],
                    tenant: 'Officina Rossi — Milano Centro', tenantBadge: true, mechanic: 'Giuseppe Rossi',
                    hasAttachments: true, isDisputed: false, isToday: true,
                  },
                  {
                    date: '12 Dic 2025', km: '38.500', type: 'CAMBIO_GOMME', title: 'Cambio gomme invernale',
                    description: 'Montaggio pneumatici invernali Michelin Alpin 6 175/65 R15.',
                    parts: ['4× Michelin Alpin 6 175/65 R15'],
                    tenant: 'Gommista Express — Milano Nord', tenantBadge: false, mechanic: 'Luca Bianchi',
                    hasAttachments: false, isDisputed: false, isToday: false,
                  },
                  {
                    date: '03 Set 2025', km: '32.100', type: 'DIAGNOSI', title: 'Diagnosi elettronica',
                    description: 'Controllo spia motore. Rilevato errore sensore lambda sostituito.',
                    parts: ['Sensore lambda Bosch'],
                    tenant: 'Officina Rossi — Milano Centro', tenantBadge: true, mechanic: 'Marco Verdi',
                    hasAttachments: true, isDisputed: false, isToday: false,
                  },
                  {
                    date: '18 Mar 2025', km: '28.900', type: 'REVISIONE', title: 'Revisione biennale',
                    description: 'Revisione ministeriale superata. Nessun difetto rilevato.',
                    parts: [],
                    tenant: 'Centro Revisione ACI — Milano Sud', tenantBadge: false, mechanic: 'Operatore MCTC',
                    hasAttachments: true, isDisputed: false, isToday: false,
                  },
                ].map((i, idx) => (
                  <div key={idx} className="bg-white border border-slate-200 rounded-xl p-5 hover:border-slate-300 transition">
                    <div className="flex items-start gap-4">
                      <div className="w-14 text-center flex-shrink-0">
                        <div className="text-xs text-slate-500 font-medium">{i.date.split(' ')[1]}</div>
                        <div className="text-xl font-bold text-slate-900">{i.date.split(' ')[0]}</div>
                        <div className="text-xs text-slate-500">{i.date.split(' ')[2]}</div>
                      </div>
                      <div className="w-px bg-slate-200 self-stretch"></div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md font-medium font-mono">{i.type}</span>
                          {i.tenantBadge && <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-md font-medium border border-blue-200">La tua officina</span>}
                          {i.isToday && <span className="text-xs bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-md font-medium border border-emerald-200">Oggi</span>}
                          {i.hasAttachments && (
                            <span className="text-xs text-slate-500 inline-flex items-center gap-1">
                              <Paperclip size={12} /> 2 allegati
                            </span>
                          )}
                        </div>
                        <div className="font-semibold text-slate-900">{i.title}</div>
                        <div className="text-sm text-slate-600 mt-1">{i.description}</div>
                        {i.parts.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {i.parts.map((p, pi) => (
                              <span key={pi} className="text-xs bg-slate-50 text-slate-700 px-2 py-1 rounded border border-slate-200">{p}</span>
                            ))}
                          </div>
                        )}
                        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
                          <div className="flex items-center gap-4 text-xs text-slate-500">
                            <span className="inline-flex items-center gap-1"><Wrench size={12} /> {i.tenant}</span>
                            <span>·</span>
                            <span>{i.km} km</span>
                            <span>·</span>
                            <span>Meccanico: {i.mechanic}</span>
                          </div>
                          <button className="text-slate-400 hover:text-slate-600">
                            <MoreHorizontal size={16} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Sidebar */}
            <div className="space-y-4">
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <h3 className="font-semibold text-slate-900 mb-3 text-sm uppercase tracking-wider">Prossime scadenze</h3>
                <div className="space-y-3">
                  <div className="p-3 bg-red-50 rounded-lg border border-red-200">
                    <div className="text-xs text-red-700 font-medium uppercase tracking-wider">Scade in 32 giorni</div>
                    <div className="font-semibold text-slate-900 mt-1 text-sm">Tagliando</div>
                    <div className="text-xs text-slate-600 mt-0.5">Prossimo: 60.000 km o 21 Apr 2027</div>
                  </div>
                  <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                    <div className="text-xs text-amber-700 font-medium uppercase tracking-wider">Scade in 8 mesi</div>
                    <div className="font-semibold text-slate-900 mt-1 text-sm">Revisione</div>
                    <div className="text-xs text-slate-600 mt-0.5">Prossima: 18 Mar 2027</div>
                  </div>
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <h3 className="font-semibold text-slate-900 mb-3 text-sm uppercase tracking-wider">Storico proprietari</h3>
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="font-medium text-slate-900">Mario Rossi</div>
                    <div className="text-xs text-slate-500">Dal 15 Mar 2021 · <span className="text-emerald-600 font-medium">Attuale</span></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NewIntervention() {
  return (
    <div className="flex">
      <Sidebar active="interventions" />

      <div className="flex-1">
        <div className="bg-white border-b border-slate-200 px-8 py-4 sticky top-[56px] z-40">
          <div className="flex items-center gap-3">
            <button className="text-slate-600 hover:text-slate-900">
              <ArrowLeft size={20} />
            </button>
            <div>
              <div className="text-xs text-slate-500">Fiat Panda · GO-482-KXRT · AB 123 CD</div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Nuovo intervento</h1>
            </div>
          </div>
        </div>

        <div className="p-8">
          <div className="max-w-4xl">
            <div className="grid grid-cols-3 gap-6">
              {/* Main form */}
              <div className="col-span-2 space-y-6">
                <div className="bg-white border border-slate-200 rounded-xl p-6">
                  <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">Dettagli intervento</h3>

                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs font-medium text-slate-700 block mb-1.5">Tipo intervento *</label>
                        <div className="relative">
                          <select className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white appearance-none pr-9 focus:outline-none focus:ring-2 focus:ring-blue-500">
                            <option>Tagliando</option>
                            <option>Cambio olio</option>
                            <option>Cambio gomme (stagione)</option>
                            <option>Cambio gomme (usura)</option>
                            <option>Distribuzione</option>
                            <option>Freni</option>
                            <option>Revisione</option>
                            <option>Diagnosi</option>
                            <option>Carrozzeria</option>
                            <option>Altro</option>
                          </select>
                          <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-slate-700 block mb-1.5">Data intervento *</label>
                        <input type="date" defaultValue="2026-04-21" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs font-medium text-slate-700 block mb-1.5">Km al momento *</label>
                        <input type="number" defaultValue="45000" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        <div className="text-xs text-slate-500 mt-1">Ultimo intervento: 38.500 km</div>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-slate-700 block mb-1.5">Titolo (opzionale)</label>
                        <input type="text" defaultValue="Tagliando completo" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-medium text-slate-700 block mb-1.5">Descrizione operazioni *</label>
                      <textarea
                        rows={4}
                        defaultValue="Sostituzione olio motore 5W30, filtro olio, filtro aria, filtro abitacolo. Controllo livelli e usura pastiglie freni. Rotazione pneumatici."
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-medium text-slate-700 block mb-1.5">Pezzi sostituiti</label>
                      <div className="space-y-2">
                        {[
                          { name: 'Olio motore Selenia 5W30', code: 'SEL-5W30-4L', qty: '4 L' },
                          { name: 'Filtro olio', code: 'UFI-23.145.02', qty: '1 pz' },
                          { name: 'Filtro aria', code: 'MANN-C28068', qty: '1 pz' },
                        ].map((p, i) => (
                          <div key={i} className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-slate-900">{p.name}</div>
                              <div className="text-xs font-mono text-slate-500">{p.code}</div>
                            </div>
                            <span className="text-xs font-medium text-slate-700 bg-white px-2 py-1 rounded border border-slate-200">{p.qty}</span>
                            <button className="text-slate-400 hover:text-red-600"><X size={16} /></button>
                          </div>
                        ))}
                        <button className="w-full py-2 border border-dashed border-slate-300 rounded-lg text-sm text-slate-600 hover:border-blue-500 hover:text-blue-600 transition inline-flex items-center justify-center gap-2">
                          <Plus size={14} /> Aggiungi pezzo
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-medium text-slate-700 block mb-1.5">
                        Note interne <span className="text-slate-400">· visibili solo all'officina</span>
                      </label>
                      <textarea
                        rows={2}
                        placeholder="Note non condivise con il cliente..."
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                      />
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-6">
                  <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">Allegati</h3>
                  <button className="w-full py-8 border-2 border-dashed border-slate-300 rounded-lg text-center hover:border-blue-500 transition group">
                    <Paperclip size={24} className="mx-auto text-slate-400 group-hover:text-blue-500 mb-2" />
                    <div className="text-sm font-medium text-slate-700">Carica foto o documenti</div>
                    <div className="text-xs text-slate-500 mt-1">JPG, PNG, HEIC, PDF · max 10 MB per file · max 10 file</div>
                  </button>
                </div>
              </div>

              {/* Sidebar: scadenza suggerita + actions */}
              <div className="space-y-4">
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <Calendar size={16} className="text-blue-700" />
                    <h3 className="font-semibold text-slate-900 text-sm">Scadenza suggerita</h3>
                  </div>
                  <div className="text-sm text-slate-700 mb-4">
                    In base al tipo di intervento, suggeriamo di creare una scadenza per il prossimo tagliando.
                  </div>
                  <div className="space-y-3 bg-white rounded-lg p-3 border border-blue-200">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-600">Entro data</span>
                      <span className="text-sm font-mono font-medium">21 Apr 2027</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-600">Oppure ai</span>
                      <span className="text-sm font-mono font-medium">60.000 km</span>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 mt-3 cursor-pointer">
                    <input type="checkbox" defaultChecked className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                    <span className="text-sm text-slate-700">Crea scadenza + invia promemoria al cliente</span>
                  </label>
                </div>

                <div className="space-y-2 sticky top-32">
                  <button className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition">
                    Salva intervento
                  </button>
                  <button className="w-full px-4 py-2.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-medium rounded-lg transition">
                    Salva e stampa PDF
                  </button>
                  <button className="w-full px-4 py-2.5 text-slate-600 hover:text-slate-900 text-sm font-medium transition">
                    Annulla
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
