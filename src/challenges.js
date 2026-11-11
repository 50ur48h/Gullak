// Random "liveness" challenges so nobody can reuse an old photo or video.
const GESTURES = [
  { id: 'peace', text: 'make a ✌️ peace sign', check: 'a hand making a peace / V sign (two fingers up)' },
  { id: 'thumbs', text: 'give a 👍 thumbs up', check: 'a hand giving a thumbs up' },
  { id: 'three', text: 'hold up 3 fingers', check: 'a hand holding up exactly three fingers' },
  { id: 'ok', text: 'make an 👌 OK sign', check: 'a hand making the OK sign (thumb and index finger forming a circle)' },
  { id: 'palm', text: 'show an open ✋ palm', check: 'an open palm with all five fingers spread' },
  { id: 'point', text: 'point 👉 at me', check: 'a finger pointing at the buddy' },
  { id: 'fist', text: 'show a ✊ fist', check: 'a closed fist' },
];

export function randomChallenge(excludeId) {
  const pool = GESTURES.filter((g) => g.id !== excludeId);
  return pool[Math.floor(Math.random() * pool.length)];
}

export function challengeById(id) {
  return GESTURES.find((g) => g.id === id) || GESTURES[0];
}
