import { describe, expect, it } from 'vitest'
import { expandICS } from '../ics'

const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR`
const range = { startAt: new Date(2026, 9, 11).getTime(), endAt: new Date(2026, 9, 15).getTime() }
describe('ICS 解析与范围截断', () => {
  it('普通时区事件保持真实时刻，全天事件保持本地全天', () => {
    const rows = expandICS(
      ics(
        'BEGIN:VEVENT\r\nUID:meeting\r\nDTSTART;TZID=Asia/Shanghai:20261012T100000\r\nDTEND;TZID=Asia/Shanghai:20261012T110000\r\nSUMMARY:学习讨论\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:holiday\r\nDTSTART;VALUE=DATE:20261013\r\nDTEND;VALUE=DATE:20261014\r\nSUMMARY:休息日\r\nEND:VEVENT'
      ),
      range
    )
    expect(rows.find((e) => e.uid === 'meeting')).toMatchObject({
      startAt: Date.parse('2026-10-12T02:00:00Z'),
      endAt: Date.parse('2026-10-12T03:00:00Z'),
      allDay: false
    })
    expect(rows.find((e) => e.uid === 'holiday')).toMatchObject({
      startAt: new Date(2026, 9, 13).getTime(),
      endAt: new Date(2026, 9, 14).getTime(),
      allDay: true
    })
  })
  it('重复规则只展开范围内实例，并排除 EXDATE', () => {
    const rows = expandICS(
      ics(
        'BEGIN:VEVENT\r\nUID:daily\r\nDTSTART:20261001T100000Z\r\nDTEND:20261001T110000Z\r\nRRULE:FREQ=DAILY;COUNT=40\r\nEXDATE:20261012T100000Z\r\nSUMMARY:学习讨论\r\nEND:VEVENT'
      ),
      range
    )
    expect(rows).toHaveLength(3)
    expect(rows.every((e) => e.startAt >= range.startAt && e.startAt < range.endAt)).toBe(true)
    expect(rows.some((e) => e.startAt === Date.parse('2026-10-12T10:00:00Z'))).toBe(false)
  })
  it('同一 UID 与时间去重，取消事件不进入日历', () => {
    const event = 'BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261013T100000Z\r\nDTEND:20261013T110000Z\r\nSUMMARY:A\r\nEND:VEVENT'
    expect(
      expandICS(
        ics(`${event}\r\n${event}\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261013T100000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT`),
        range
      ).map((e) => e.uid)
    ).toEqual(['a'])
  })
  it('无效输入报错，避免刷新时清空原有日历', () => {
    expect(() => expandICS('<html>not a calendar</html>', range)).toThrow()
  })
  it('全天重复事件不因本地时区移动到前一天', () => {
    const rows = expandICS(ics('BEGIN:VEVENT\r\nUID:all-day\r\nDTSTART;VALUE=DATE:20261012\r\nDTEND;VALUE=DATE:20261013\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:日历日\r\nEND:VEVENT'), range)
    expect(rows.map((r) => r.startAt)).toEqual([12, 13, 14].map((d) => new Date(2026, 9, d).getTime()))
  })
})
