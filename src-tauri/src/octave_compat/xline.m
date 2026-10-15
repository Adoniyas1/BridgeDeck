function h = xline(x, spec, label)
  % BridgeDeck fill-in for MATLAB's xline: a vertical line across the current axes.
  if nargin < 2 || isempty(spec), spec = 'k-'; end
  ax = gca; held = ishold(ax); hold(ax, 'on');
  yl = ylim(ax); h = [];
  for k = 1:numel(x)
    h(end+1) = plot(ax, [x(k) x(k)], yl, spec);
    if nargin >= 3, text(ax, x(k), yl(2), [' ' label], 'VerticalAlignment', 'top'); end
  end
  ylim(ax, yl);
  if ~held, hold(ax, 'off'); end
end
