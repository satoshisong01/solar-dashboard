import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET() {
  try {
    const client = await pool.connect();

    // 1. 발전소 목록
    const siteQuery = `
      SELECT s.id, s.name, s.lat, s.lng, s.capacity, 
             l.gen, l.cons, l.sales, l.eff, l.status, l.ai_msg, l.is_error 
      FROM solar_sites s 
      LEFT JOIN LATERAL (SELECT * FROM solar_logs WHERE site_id = s.id ORDER BY recorded_at DESC LIMIT 1) l ON true
      ORDER BY s.id ASC
    `;
    const { rows: sites } = await client.query(siteQuery);

    // 2. 조치사항 병합
    for (let site of sites) {
      const { rows: actions } = await client.query(
        'SELECT action_text FROM solar_actions WHERE site_id = $1',
        [site.id]
      );
      site.actions = actions.map((a: any) => a.action_text);
      site.chartData = site.is_error
        ? [90, 160, 150, 140, 80, 20]
        : [100, 320, 500, 750, 850, 600];
    }

    // 3. 수익 데이터
    const { rows: revenue } = await client.query(
      'SELECT month, amount FROM solar_revenue ORDER BY id ASC'
    );

    // 4. 인버터 데이터
    const { rows: inverters } = await client.query(
      'SELECT * FROM solar_inverter_status ORDER BY id ASC'
    );

    // 🌟 [핵심] 여기가 빠져있을 겁니다! 통계 데이터 가져오기 🌟
    const { rows: statsRows } = await client.query('SELECT * FROM solar_stats');
    const stats = statsRows.reduce((acc: any, cur: any) => {
      acc[cur.key_name] = cur.val; // 배열을 객체로 변환 { sunlight_hours: 6.2, ... }
      return acc;
    }, {});

    // 6. 시장 가격
    const { rows: marketRows } = await client.query(
      'SELECT * FROM solar_market'
    );
    const market = marketRows.reduce((acc: any, cur: any) => {
      acc[cur.type] = cur;
      return acc;
    }, {});

    // 7. 일정 데이터
    const { rows: schedule } = await client.query(
      'SELECT * FROM solar_schedule ORDER BY id ASC'
    );

    client.release();

    // stats를 꼭 포함해서 리턴해야 합니다!
    return NextResponse.json({
      sites,
      revenue,
      inverters,
      stats,
      market,
      schedule,
    });
  } catch (error) {
    console.error('DB Error:', error);
    return NextResponse.json({ error: 'Database Error' }, { status: 500 });
  }
}
