import { useState } from 'react';
import { Car, Bell, Settings, ChevronRight, ChevronLeft, Plus, Wrench, Calendar, Check, Shield, Clock, AlertCircle, QrCode, Camera, MoreVertical, Zap, Gauge, Fuel, Heart, TrendingUp, MapPin, Share2, Download, ArrowUpRight, UserCheck, Eye } from 'lucide-react';

export default function GarageOSClienteDesign() {
  const [currentView, setCurrentView] = useState('home');

  const views = [
    { id: 'home', label: 'Home' },
    { id: 'vehicle', label: 'Dettaglio' },
    { id: 'addprivate', label: 'Intervento Privato' },
    { id: 'audit', label: 'Audit Accessi' },
  ];

  return (
    <div className="min-h-screen bg-slate-100 pb-20" style={{ fontFamily: "'Manrope', -apple-system, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap');
        .font-mono { font-family: 'JetBrains Mono', monospace; }
      `}</style>

      {/* Top bar (demo only) */}
      <div className="bg-slate-900 text-white px-6 py-3 sticky top-0 z-50 shadow-lg">
        <div className="flex items-center justify-between max-w-[1400px] mx-auto">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-bold">G</div>
            <div className="font-bold text-lg tracking-tight">GarageOS <span className="text-slate-400 font-normal">— Mobile App Design</span></div>
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

      {/* Mobile frame */}
      <div className="max-w-[420px] mx-auto mt-8">
        <div className="bg-white rounded-[40px] shadow-2xl overflow-hidden border-[10px] border-slate-900 relative" style={{ minHeight: '820px' }}>
          {/* Notch */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-6 bg-slate-900 rounded-b-2xl z-40"></div>

          {/* Status bar */}
          <div className="pt-3 pb-2 px-6 flex items-center justify-between text-xs font-semibold">
            <span>9:41</span>
            <div className="flex items-center gap-1">
              <span className="w-4 h-2 bg-slate-900 rounded-sm"></span>
              <span className="w-4 h-2 bg-slate-900 rounded-sm"></span>
              <span>100%</span>
            </div>
          </div>

          {currentView === 'home' && <HomeScreen />}
          {currentView === 'vehicle' && <VehicleDetailScreen />}
          {currentView === 'addprivate' && <AddPrivateInterventionScreen />}
          {currentView === 'audit' && <AuditLogScreen />}
        </div>

        <div className="text-center mt-6 text-xs text-slate-500">
          Tap sui tab in alto per navigare tra le schermate
        </div>
      </div>
    </div>
  );
}

function HomeScreen() {
  return (
    <div>
      {/* Header */}
      <div className="px-6 pt-2 pb-4 flex items-center justify-between">
        <div>
          <div className="text-sm text-slate-500">Buongiorno</div>
          <div className="text-2xl font-bold text-slate-900">Mario</div>
        </div>
        <div className="flex gap-2">
          <button className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center relative">
            <Bell size={18} className="text-slate-700" />
            <div className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full"></div>
          </button>
          <button className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center">
            <Settings size={18} className="text-slate-700" />
          </button>
        </div>
      </div>

      {/* Deadline alert */}
      <div className="px-6 mb-6">
        <div className="bg-gradient-to-br from-amber-400 to-orange-500 rounded-3xl p-5 text-white relative overflow-hidden">
          <div className="absolute -right-8 -top-8 w-32 h-32 bg-white/10 rounded-full"></div>
          <div className="absolute -right-4 -bottom-12 w-24 h-24 bg-white/10 rounded-full"></div>
          <div className="relative">
            <div className="flex items-center gap-2 mb-2">
              <Clock size={16} />
              <span className="text-xs font-semibold uppercase tracking-wider">Scadenza vicina</span>
            </div>
            <div className="text-xl font-bold mb-1">Tagliando tra 32 giorni</div>
            <div className="text-white/90 text-sm mb-3">La tua Fiat Panda ha bisogno del tagliando entro il 23 maggio o al raggiungimento dei 60.000 km.</div>
            <button className="bg-white text-orange-600 px-4 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-1">
              Prenota ora <ArrowUpRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* My vehicles */}
      <div className="px-6 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-slate-900">I tuoi veicoli</h2>
          <button className="text-blue-600 text-sm font-semibold inline-flex items-center gap-1">
            <Plus size={14} /> Aggiungi
          </button>
        </div>

        <div className="space-y-3">
          {/* Vehicle card 1 */}
          <div className="bg-gradient-to-br from-slate-900 to-slate-700 rounded-3xl p-5 text-white relative overflow-hidden">
            <div className="absolute -right-12 -top-12 w-40 h-40 bg-white/5 rounded-full"></div>

            <div className="relative">
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <div className="text-xs text-white/60 font-medium uppercase tracking-wider mb-1">La tua auto</div>
                  <div className="text-xl font-bold">Fiat Panda</div>
                  <div className="text-white/70 text-sm">1.2 Lounge · 2021</div>
                </div>
                <div className="text-right">
                  <div className="inline-flex items-center gap-1 bg-emerald-500/20 text-emerald-300 text-xs font-semibold px-2 py-1 rounded-full">
                    <Shield size={10} /> Certificato
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 mb-4">
                <div>
                  <div className="text-xs text-white/50 uppercase tracking-wider">Km</div>
                  <div className="font-bold">45.000</div>
                </div>
                <div>
                  <div className="text-xs text-white/50 uppercase tracking-wider">Targa</div>
                  <div className="font-mono font-bold text-sm">AB 123 CD</div>
                </div>
                <div>
                  <div className="text-xs text-white/50 uppercase tracking-wider">Codice</div>
                  <div className="font-mono font-bold text-sm text-blue-300">GO-482</div>
                </div>
              </div>

              <button className="w-full bg-white/10 backdrop-blur hover:bg-white/20 py-2.5 rounded-xl text-sm font-semibold transition inline-flex items-center justify-center gap-2">
                Vedi storico completo <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* Vehicle card 2 (smaller) */}
          <div className="bg-white border-2 border-slate-200 rounded-3xl p-4 flex items-center gap-4">
            <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center text-white">
              <Car size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-slate-900 truncate">Vespa Primavera</div>
              <div className="text-xs text-slate-500">2018 · 12.400 km</div>
              <div className="font-mono text-xs text-blue-600 mt-0.5">GO-739-MXWL</div>
            </div>
            <ChevronRight size={20} className="text-slate-400" />
          </div>
        </div>
      </div>

      {/* Recent activity */}
      <div className="px-6 mb-6">
        <h2 className="text-lg font-bold text-slate-900 mb-3">Attività recenti</h2>

        <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden">
          {[
            {
              icon: Wrench, iconBg: 'bg-blue-100', iconColor: 'text-blue-600',
              title: 'Nuovo tagliando', subtitle: 'Fiat Panda · Officina Rossi',
              time: 'Oggi, 14:32', isNew: true,
            },
            {
              icon: Eye, iconBg: 'bg-slate-100', iconColor: 'text-slate-600',
              title: 'Accesso al veicolo', subtitle: 'Officina Rossi ha consultato la scheda',
              time: 'Oggi, 14:28', isNew: false,
            },
            {
              icon: Calendar, iconBg: 'bg-amber-100', iconColor: 'text-amber-600',
              title: 'Scadenza in arrivo', subtitle: 'Revisione tra 8 mesi',
              time: 'Ieri, 09:00', isNew: false,
            },
          ].map((a, i) => {
            const Icon = a.icon;
            return (
              <div key={i} className={`p-4 flex items-center gap-3 ${i !== 2 ? 'border-b border-slate-100' : ''}`}>
                <div className={`w-10 h-10 ${a.iconBg} ${a.iconColor} rounded-full flex items-center justify-center flex-shrink-0`}>
                  <Icon size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900 text-sm">{a.title}</span>
                    {a.isNew && <span className="w-2 h-2 bg-blue-500 rounded-full"></span>}
                  </div>
                  <div className="text-xs text-slate-500 truncate">{a.subtitle}</div>
                </div>
                <div className="text-xs text-slate-400 flex-shrink-0">{a.time}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom nav */}
      <BottomNav active="home" />
    </div>
  );
}

function VehicleDetailScreen() {
  return (
    <div>
      {/* Header */}
      <div className="px-4 pt-2 pb-2 flex items-center gap-3">
        <button className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center">
          <ChevronLeft size={20} className="text-slate-700" />
        </button>
        <div className="flex-1"></div>
        <button className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center">
          <Share2 size={18} className="text-slate-700" />
        </button>
        <button className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center">
          <MoreVertical size={18} className="text-slate-700" />
        </button>
      </div>

      {/* Hero */}
      <div className="px-6 py-4">
        <div className="text-sm text-slate-500">Il tuo veicolo</div>
        <div className="text-3xl font-bold text-slate-900 tracking-tight">Fiat Panda</div>
        <div className="text-slate-500 text-sm">1.2 Lounge · 2021 · Bianco Gelato</div>
      </div>

      {/* Code card */}
      <div className="px-6 mb-4">
        <div className="bg-blue-50 border-2 border-blue-200 rounded-2xl p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-blue-700 font-semibold uppercase tracking-wider mb-1">Codice GarageOS</div>
            <div className="font-mono text-xl font-bold text-blue-900">GO-482-KXRT</div>
          </div>
          <button className="w-12 h-12 bg-white rounded-xl flex items-center justify-center shadow-sm border border-blue-200">
            <QrCode size={22} className="text-blue-600" />
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="px-6 mb-6">
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-slate-100 rounded-2xl p-3 text-center">
            <Gauge size={18} className="mx-auto text-slate-600 mb-1" />
            <div className="text-lg font-bold text-slate-900">45k</div>
            <div className="text-xs text-slate-500">km</div>
          </div>
          <div className="bg-slate-100 rounded-2xl p-3 text-center">
            <Fuel size={18} className="mx-auto text-slate-600 mb-1" />
            <div className="text-lg font-bold text-slate-900">Benzina</div>
            <div className="text-xs text-slate-500">1242 cc</div>
          </div>
          <div className="bg-slate-100 rounded-2xl p-3 text-center">
            <TrendingUp size={18} className="mx-auto text-slate-600 mb-1" />
            <div className="text-lg font-bold text-slate-900">8</div>
            <div className="text-xs text-slate-500">interventi</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6 mb-4">
        <div className="bg-slate-100 rounded-full p-1 flex">
          <button className="flex-1 py-2 px-3 rounded-full bg-white shadow-sm text-sm font-semibold text-slate-900">
            Storico
          </button>
          <button className="flex-1 py-2 px-3 rounded-full text-sm font-semibold text-slate-500">
            Scadenze
          </button>
          <button className="flex-1 py-2 px-3 rounded-full text-sm font-semibold text-slate-500">
            Info
          </button>
        </div>
      </div>

      {/* Timeline */}
      <div className="px-6 space-y-3 mb-6">
        {/* Officina - oggi */}
        <div className="bg-white border-2 border-blue-200 rounded-2xl p-4 relative">
          <div className="absolute -top-2 left-4 bg-blue-600 text-white text-xs font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1">
            <Shield size={10} /> Certificato · Oggi
          </div>
          <div className="flex items-start gap-3 mt-2">
            <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center text-blue-600 flex-shrink-0">
              <Wrench size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-slate-900">Tagliando completo</div>
              <div className="text-xs text-slate-500 mb-2">Officina Rossi · Milano Centro</div>
              <div className="text-sm text-slate-700 line-clamp-2">Sostituzione olio motore 5W30, filtro olio, filtro aria, filtro abitacolo...</div>
              <div className="flex items-center gap-2 mt-3 text-xs text-slate-500">
                <span>45.000 km</span>
                <span>·</span>
                <span>4 pezzi</span>
                <span>·</span>
                <span>2 foto</span>
              </div>
            </div>
          </div>
        </div>

        {/* Privato */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 border-dashed">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center text-purple-600 flex-shrink-0">
              <UserCheck size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-900">Rabbocco olio</span>
                <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-semibold">Privato</span>
              </div>
              <div className="text-xs text-slate-500 mb-2">Registrato da te · 10 Mar 2026</div>
              <div className="text-sm text-slate-700">Aggiunto 0.5L di olio Selenia 5W30</div>
              <div className="flex items-center gap-2 mt-2 text-xs text-slate-500">
                <span>43.500 km</span>
              </div>
            </div>
          </div>
        </div>

        {/* Officina - passato */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center text-blue-600 flex-shrink-0">
              <Wrench size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-900">Cambio gomme invernale</span>
                <Shield size={12} className="text-emerald-600" />
              </div>
              <div className="text-xs text-slate-500 mb-2">Gommista Express · Milano Nord · 12 Dic 2025</div>
              <div className="text-sm text-slate-700 line-clamp-1">4× Michelin Alpin 6 175/65 R15</div>
              <div className="flex items-center gap-2 mt-2 text-xs text-slate-500">
                <span>38.500 km</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <BottomNav active="home" />
    </div>
  );
}

function AddPrivateInterventionScreen() {
  return (
    <div>
      {/* Header */}
      <div className="px-4 pt-2 pb-2 flex items-center justify-between">
        <button className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center">
          <ChevronLeft size={20} className="text-slate-700" />
        </button>
        <div className="text-sm font-semibold text-slate-900">Nuovo intervento privato</div>
        <div className="w-10"></div>
      </div>

      <div className="px-6 py-4">
        {/* Badge info */}
        <div className="bg-purple-50 border border-purple-200 rounded-2xl p-3 mb-5 flex items-start gap-3">
          <div className="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center text-purple-600 flex-shrink-0">
            <UserCheck size={14} />
          </div>
          <div>
            <div className="text-sm font-semibold text-purple-900">Intervento privato</div>
            <div className="text-xs text-purple-700 mt-0.5">Visibile solo a te. Non viene certificato e non è trasferito se vendi l'auto.</div>
          </div>
        </div>

        {/* Vehicle */}
        <div className="mb-4">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Veicolo</label>
          <div className="bg-slate-100 rounded-2xl p-3 flex items-center gap-3">
            <div className="w-10 h-10 bg-slate-900 rounded-xl flex items-center justify-center text-white">
              <Car size={18} />
            </div>
            <div>
              <div className="font-semibold text-slate-900 text-sm">Fiat Panda</div>
              <div className="font-mono text-xs text-slate-500">GO-482-KXRT</div>
            </div>
          </div>
        </div>

        {/* Type */}
        <div className="mb-4">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Tipo intervento</label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { icon: Fuel, label: 'Olio' },
              { icon: Zap, label: 'Elettrico' },
              { icon: Gauge, label: 'Gomme' },
              { icon: Wrench, label: 'Riparazione' },
              { icon: Heart, label: 'Cura' },
              { icon: Plus, label: 'Altro' },
            ].map((t, i) => {
              const Icon = t.icon;
              const selected = i === 0;
              return (
                <button
                  key={i}
                  className={`py-3 rounded-2xl flex flex-col items-center gap-1 transition ${
                    selected
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  <Icon size={20} />
                  <span className="text-xs font-semibold">{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Date and KM */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Data</label>
            <div className="bg-slate-100 rounded-2xl px-4 py-3 text-sm font-semibold text-slate-900">
              10 marzo 2026
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Km (opzionale)</label>
            <input
              type="text"
              placeholder="Es. 43500"
              defaultValue="43500"
              className="w-full bg-slate-100 rounded-2xl px-4 py-3 text-sm font-mono font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Description */}
        <div className="mb-4">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Cosa hai fatto?</label>
          <textarea
            rows={4}
            placeholder="Descrivi l'intervento in modo libero..."
            defaultValue="Aggiunto 0.5L di olio Selenia 5W30 trovato sottoposto. Controllato livello dopo 10 minuti."
            className="w-full bg-slate-100 rounded-2xl px-4 py-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        {/* Attachments */}
        <div className="mb-6">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Foto</label>
          <div className="flex gap-2">
            <button className="w-20 h-20 bg-slate-100 hover:bg-slate-200 rounded-2xl flex flex-col items-center justify-center transition">
              <Camera size={20} className="text-slate-600 mb-1" />
              <span className="text-xs text-slate-600 font-medium">Foto</span>
            </button>
            <div className="w-20 h-20 bg-gradient-to-br from-blue-400 to-blue-600 rounded-2xl relative">
              <button className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-white text-xs flex items-center justify-center">×</button>
            </div>
          </div>
        </div>

        {/* Save button */}
        <button className="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-2xl font-bold text-base transition">
          Salva intervento
        </button>
      </div>

      <BottomNav active="home" />
    </div>
  );
}

function AuditLogScreen() {
  return (
    <div>
      {/* Header */}
      <div className="px-4 pt-2 pb-2 flex items-center gap-3">
        <button className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center">
          <ChevronLeft size={20} className="text-slate-700" />
        </button>
        <div>
          <div className="text-sm font-semibold text-slate-900">Audit accessi</div>
          <div className="text-xs text-slate-500">Fiat Panda · GO-482-KXRT</div>
        </div>
      </div>

      {/* Info banner */}
      <div className="px-6 py-4">
        <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-3xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white">
              <Shield size={14} />
            </div>
            <div className="font-bold text-slate-900 text-sm">Trasparenza garantita</div>
          </div>
          <div className="text-xs text-slate-700 leading-relaxed">
            Qui vedi ogni volta che un'officina consulta lo storico del tuo veicolo. Se noti accessi sospetti, puoi contestarli direttamente sull'intervento.
          </div>
        </div>
      </div>

      {/* Filter */}
      <div className="px-6 mb-4">
        <div className="flex gap-2 overflow-x-auto">
          <button className="px-4 py-1.5 bg-slate-900 text-white text-xs font-semibold rounded-full whitespace-nowrap">
            Tutti
          </button>
          <button className="px-4 py-1.5 bg-slate-100 text-slate-700 text-xs font-semibold rounded-full whitespace-nowrap">
            Questo mese
          </button>
          <button className="px-4 py-1.5 bg-slate-100 text-slate-700 text-xs font-semibold rounded-full whitespace-nowrap">
            Solo consultazioni
          </button>
          <button className="px-4 py-1.5 bg-slate-100 text-slate-700 text-xs font-semibold rounded-full whitespace-nowrap">
            Solo interventi
          </button>
        </div>
      </div>

      {/* Log list */}
      <div className="px-6 space-y-3 mb-6">
        {[
          {
            type: 'intervention', action: 'Ha registrato un intervento',
            tenant: 'Officina Rossi', city: 'Milano Centro',
            time: 'Oggi, 14:32',
            user: 'Giuseppe Rossi', isToday: true, color: 'blue',
          },
          {
            type: 'view', action: 'Ha consultato lo storico',
            tenant: 'Officina Rossi', city: 'Milano Centro',
            time: 'Oggi, 14:28',
            user: 'Giuseppe Rossi', isToday: true, color: 'slate',
          },
          {
            type: 'intervention', action: 'Ha registrato un intervento',
            tenant: 'Gommista Express', city: 'Milano Nord',
            time: '12 Dic 2025, 10:15',
            user: 'Luca Bianchi', isToday: false, color: 'blue',
          },
          {
            type: 'view', action: 'Ha consultato lo storico',
            tenant: 'Gommista Express', city: 'Milano Nord',
            time: '12 Dic 2025, 10:10',
            user: 'Luca Bianchi', isToday: false, color: 'slate',
          },
          {
            type: 'intervention', action: 'Ha registrato revisione',
            tenant: 'Centro Revisione ACI', city: 'Milano Sud',
            time: '18 Mar 2025, 09:30',
            user: 'Operatore MCTC', isToday: false, color: 'blue',
          },
        ].map((l, i) => {
          const isBlue = l.color === 'blue';
          return (
            <div key={i} className="bg-white border border-slate-200 rounded-2xl p-4">
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isBlue ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-600'
                }`}>
                  {isBlue ? <Wrench size={16} /> : <Eye size={16} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900 text-sm">{l.action}</span>
                    {l.isToday && <span className="w-1.5 h-1.5 bg-blue-500 rounded-full"></span>}
                  </div>
                  <div className="text-sm text-slate-700 mt-1">{l.tenant}</div>
                  <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-1">
                    <MapPin size={10} /> {l.city} · Meccanico: {l.user}
                  </div>
                  <div className="text-xs text-slate-400 mt-1">{l.time}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Suspicious report */}
      <div className="px-6 mb-6">
        <button className="w-full bg-red-50 border border-red-200 text-red-700 py-3 rounded-2xl text-sm font-semibold flex items-center justify-center gap-2">
          <AlertCircle size={16} /> Segnala accesso sospetto
        </button>
      </div>

      <BottomNav active="home" />
    </div>
  );
}

function BottomNav({ active }) {
  const items = [
    { id: 'home', label: 'Home', icon: Car },
    { id: 'history', label: 'Storico', icon: Wrench },
    { id: 'deadlines', label: 'Scadenze', icon: Calendar },
    { id: 'profile', label: 'Profilo', icon: UserCheck },
  ];

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-[400px] max-w-[calc(100%-20px)] mx-auto">
      <div className="mx-2 mb-2 bg-white border border-slate-200 rounded-full px-4 py-2 flex items-center justify-around shadow-lg">
        {items.map(item => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-full transition ${
                isActive ? 'text-blue-600' : 'text-slate-400'
              }`}
            >
              <Icon size={20} />
              <span className="text-[10px] font-semibold">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
