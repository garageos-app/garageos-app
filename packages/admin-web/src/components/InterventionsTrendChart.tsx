import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { WeeklyTrendPoint } from '@/lib/metrics-types';

// YYYY-MM-DD → DD/MM for compact x-axis labels.
function formatWeek(week: string): string {
  const parts = week.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : week;
}

interface InterventionsTrendChartProps {
  data: WeeklyTrendPoint[];
}

export function InterventionsTrendChart({ data }: InterventionsTrendChartProps) {
  const chartData = data.map((p) => ({ week: formatWeek(p.week), count: p.count }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Interventi per settimana (ultime 8)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64" data-testid="trend-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="week" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis
                allowDecimals={false}
                fontSize={12}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip />
              <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
