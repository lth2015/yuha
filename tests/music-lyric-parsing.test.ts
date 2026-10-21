import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { sectionName } from '@yuha/contracts';

describe('music service lyric grammar', () => {
  it('agrees with the player on section labels versus sung words', () => {
    const lines = ['[Verse 1]', '(verse 2)', '(Bメロ)', '[サビ]', '(副歌)', '(ooh ooh)', '（别走）',
      '(stay with me)', '【明天见】', '[arbitrary section]', '晚风吹过', ''];
    const actual = JSON.parse(execFileSync('python3', ['-c',
      'import sys,json; sys.path.insert(0,"deploy/dgx/music/server"); from align import section_name; print(json.dumps([section_name(line) for line in json.load(sys.stdin)]))',
    ], { input: JSON.stringify(lines), encoding: 'utf8' }));
    expect(actual).toEqual(lines.map(sectionName));
  });
});
