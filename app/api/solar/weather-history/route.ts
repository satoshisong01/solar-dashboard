import { NextResponse } from 'next/server';
import pool from '@/lib/db';

// 30분마다 날씨 데이터를 저장하는 전용 API
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { site_id, temp, humidity, weather } = body;

    const client = await pool.connect();

    await client.query(
      `INSERT INTO solar_weather_history (site_id, temp, humidity, weather, recorded_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [site_id, temp, humidity, weather]
    );

    client.release();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Weather History Save Error:', error);
    return NextResponse.json({ error: 'Save Failed' }, { status: 500 });
  }
}
