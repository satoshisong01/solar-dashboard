import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = searchParams.get('lat');
  const lon = searchParams.get('lon');

  const apiKey = process.env.OPENWEATHER_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: 'API Key not found' }, { status: 500 });
  }

  // 좌표가 없으면 기본값 (서울 시청)
  const targetLat = lat || '37.5665';
  const targetLon = lon || '126.9780';

  try {
    // 🌟 도시 이름(q) 대신 좌표(lat, lon)로 조회
    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${targetLat}&lon=${targetLon}&appid=${apiKey}&units=metric`
    );

    if (!res.ok) throw new Error('Weather API Failed');

    const data = await res.json();

    return NextResponse.json({
      temp: data.main.temp,
      humidity: data.main.humidity,
      weather: data.weather[0].main,
      description: data.weather[0].description,
      city: data.name, // 어느 도시인지 확인용
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({
      temp: 20,
      humidity: 50,
      weather: 'Clear',
      city: 'Unknown',
    });
  }
}
