// What the probe station shows: one recorded Calculator investigation, read
// pad by pad. Every value on the instrument comes from
// website/evidence/calculator-and-dino.md; nothing here is invented.

// Bond pads sit on a 4.5-unit pitch around a 30-unit die, 1.8 units in from
// its edge. Pad positions are relative to the die centre.
export const DIE = 30;
export const PITCH = 4.5;
export const PAD_INSET = 1.8;
export const PADS_PER_SIDE = 6;
export const padAlong = (index) => (index - (PADS_PER_SIDE - 1) / 2) * PITCH;
const EDGE = DIE / 2 - PAD_INSET;

// Each step is one pad the needle lands on and what the instrument reads there.
export const STEPS = [
  {
    pad: [EDGE, padAlong(1)],
    readout: "CalcViewModel.dll",
    lines: ["CalcViewModel.dll", "sha256 07a1953b…10df5", "x64 11.2508.4.0"],
  },
  {
    pad: [EDGE, padAlong(2)],
    readout: "fn 0x1801245d0",
    lines: ["fn 0x1801245d0", "case 0x76", "10,656 bytes in 2 ranges"],
  },
  {
    pad: [EDGE, padAlong(3)],
    readout: "0x180124949",
    lines: ["0x180124949", "CMP EAX, 0x5c", "IDC_MUL = 0x5c"],
  },
  {
    pad: [EDGE, padAlong(4)],
    readout: "0x18012495b",
    lines: ["0x18012495b", "MOV EDX, 0x64", "0x64 = 100"],
  },
  {
    pad: [padAlong(4), EDGE],
    readout: "200 + 10% = 220",
    lines: ["200 + 10% = 220", "200 × 10% = 20", "rat / 100"],
  },
];

// The needle stays put; the stage carries the die so the chosen pad comes
// under the tip. The rest pose puts STEPS[0] under the needle.
export function stageFor(step, tip, centre) {
  const [px, py] = STEPS[step].pad;
  return [tip[0] - (centre[0] + px), tip[1] - (centre[1] + py)];
}
