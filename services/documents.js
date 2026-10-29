// petia-backend/services/documents.js
// Documents des familles d'accueil (coffre-fort) et demandes des refuges.
//   • fichiers dans le stockage privé Supabase « documents-fa » (jamais public)
//   • accès uniquement par liens signés de 60 secondes, générés par le serveur
//   • un refuge ne voit que les documents que la famille a joints à SES demandes
//   • PDF, JPG ou PNG de 5 Mo maximum, type contrôlé sur le contenu réel du fichier
//   • suppression automatique : 3 mois après la fin de l'accueil, 6 mois après le dépôt si jamais utilisé

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BUCKET = 'documents-fa';
const TAILLE_MAX = 5 * 1024 * 1024;

const TYPES_DOC = {
  attestation_rc: 'Attestation d\'assurance responsabilité civile',
  justificatif_domicile: 'Justificatif de domicile',
  accord_bailleur: 'Accord du propriétaire / règlement de copropriété',
  autre: 'Autre document',
};

// Type réel du fichier, d'après ses premiers octets
function typeFichier(buf) {
  if (buf.length > 4 && buf.slice(0, 4).toString('latin1') === '%PDF') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { mime: 'image/png', ext: 'png' };
  return null;
}

async function deposer(familleId, { type, libelle, base64 }) {
  if (!TYPES_DOC[type]) throw Object.assign(new Error('Type de document invalide.'), { status: 400 });
  if (typeof base64 !== 'string' || !base64) throw Object.assign(new Error('Fichier manquant.'), { status: 400 });
  const buf = Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length) throw Object.assign(new Error('Fichier vide.'), { status: 400 });
  if (buf.length > TAILLE_MAX) throw Object.assign(new Error('Fichier trop lourd (5 Mo maximum).'), { status: 400 });
  const t = typeFichier(buf);
  if (!t) throw Object.assign(new Error('Format non accepté : PDF, JPG ou PNG uniquement.'), { status: 400 });
  const chemin = `${familleId}/${crypto.randomUUID()}.${t.ext}`;
  const { error: e1 } = await supabase.storage.from(BUCKET).upload(chemin, buf, { contentType: t.mime, upsert: false });
  if (e1) throw e1;
  const { data, error } = await supabase.from('documents_fa').insert({
    famille_id: familleId, type, libelle: (typeof libelle === 'string' && libelle.trim() ? libelle.trim() : TYPES_DOC[type]).slice(0, 150),
    chemin, mime: t.mime, taille: buf.length, empreinte: crypto.createHash('sha256').update(buf).digest('hex'),
  }).select('id, type, libelle, mime, taille, depose_le').single();
  if (error) { await supabase.storage.from(BUCKET).remove([chemin]).catch(() => {}); throw error; }
  return data;
}

async function lienSigne(chemin) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(chemin, 60);
  if (error) throw error;
  return data.signedUrl;
}

async function supprimerDocuments(docs) {
  if (!docs?.length) return 0;
  await supabase.storage.from(BUCKET).remove(docs.map(d => d.chemin)).catch(e => console.error('Stockage remove:', e.message));
  // Une demande dont le document disparaît redevient « à fournir » (sauf si déjà validée : l'historique reste)
  await supabase.from('demandes_documents').update({ statut: 'demande', document_id: null, maj_le: new Date().toISOString() })
    .in('document_id', docs.map(d => d.id)).neq('statut', 'valide');
  const { error } = await supabase.from('documents_fa').delete().in('id', docs.map(d => d.id));
  if (error) throw error;
  return docs.length;
}

// Supprime tous les fichiers d'une famille (suppression du compte)
async function supprimerTousLesDocuments(familleId) {
  const { data } = await supabase.from('documents_fa').select('id, chemin').eq('famille_id', familleId);
  return supprimerDocuments(data || []);
}

// Liste par défaut du refuge → demandes créées quand la famille accepte une proposition
async function creerDemandesParDefaut(matchId) {
  const { data: m } = await supabase.from('matchs').select('id, animal:animaux(refuge:refuges(details))').eq('id', matchId).maybeSingle();
  const liste = m?.animal?.refuge?.details?.documents_defaut || [];
  if (!liste.length) return;
  const { count } = await supabase.from('demandes_documents').select('id', { count: 'exact', head: true }).eq('match_id', matchId);
  if (count) return; // déjà créées
  await supabase.from('demandes_documents').insert(liste.filter(d => TYPES_DOC[d.type]).map(d => ({
    match_id: matchId, type: d.type, libelle: d.libelle || TYPES_DOC[d.type], obligatoire: d.obligatoire !== false,
  })));
}

async function demandesDuMatch(matchId) {
  const { data } = await supabase.from('demandes_documents')
    .select('id, type, libelle, obligatoire, statut, motif_refus, cree_le, maj_le, document:documents_fa(id, libelle, mime, taille, depose_le)')
    .eq('match_id', matchId).order('cree_le');
  return data || [];
}

// Documents obligatoires pas encore validés par le refuge
async function obligatoiresManquants(matchId) {
  const { data } = await supabase.from('demandes_documents').select('libelle, statut').eq('match_id', matchId).eq('obligatoire', true).neq('statut', 'valide');
  return (data || []).map(d => d.libelle);
}

// Durées de conservation (appelé par la purge quotidienne)
async function purgerDocuments() {
  const JOUR = 86400000;
  const { data: docs } = await supabase.from('documents_fa').select('id, chemin, depose_le');
  if (!docs?.length) return 0;
  const { data: liens } = await supabase.from('demandes_documents')
    .select('document_id, match:matchs(statut, date_fin_accueil, updated_at)').in('document_id', docs.map(d => d.id));
  const parDoc = {};
  for (const l of liens || []) (parDoc[l.document_id] = parDoc[l.document_id] || []).push(l.match);
  const aSupprimer = docs.filter(d => {
    const ms = (parDoc[d.id] || []).filter(Boolean);
    if (!ms.length) return Date.now() - new Date(d.depose_le).getTime() > 182 * JOUR;
    if (ms.some(m => ['propose', 'accepte', 'en_cours'].includes(m.statut))) return false;
    const fin = Math.max(...ms.map(m => new Date(m.date_fin_accueil || m.updated_at).getTime()));
    return Date.now() - fin > 91 * JOUR;
  });
  return supprimerDocuments(aSupprimer);
}

module.exports = {
  TYPES_DOC, deposer, lienSigne, supprimerDocuments, supprimerTousLesDocuments,
  creerDemandesParDefaut, demandesDuMatch, obligatoiresManquants, purgerDocuments, supabase,
};
