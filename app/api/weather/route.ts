import { NextResponse } from 'next/server';

export async function GET() {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  const city = process.env.WEATHER_CITY || 'Seoul';

  if (!apiKey) {
    return NextResponse.json({ error: 'API Key not found' }, { status: 500 });
  }

  try {
    // OpenWeatherMap API 호출 (섭씨 온도: units=metric)
    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`
    );

    if (!res.ok) throw new Error('Weather API Failed');

    const data = await res.json();

    // 우리가 필요한 데이터만 정리해서 보냄
    return NextResponse.json({
      temp: data.main.temp, // 온도
      humidity: data.main.humidity, // 습도
      weather: data.weather[0].main, // 날씨 (Clear, Rain, Clouds ...)
      description: data.weather[0].description, // 상세 설명
    });
  } catch (error) {
    console.error(error);
    // 에러나면 기본값 반환 (앱이 멈추지 않도록)
    return NextResponse.json({
      temp: 25,
      humidity: 50,
      weather: 'Clear',
    });
  }
}
