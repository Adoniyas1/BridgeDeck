function exportgraphics(obj, file, varargin)
  % BridgeDeck fill-in for MATLAB's exportgraphics (PNG, JPG, PDF or SVG by the file's ending).
  [~, ~, ext] = fileparts(file);
  fmt = struct('png', '-dpng', 'jpg', '-djpeg', 'jpeg', '-djpeg', 'pdf', '-dpdf', 'svg', '-dsvg');
  key = lower(ext(2:end));
  if isfield(fmt, key), dev = fmt.(key); else, dev = '-dpng'; end
  f = obj; if ~strcmp(get(f, 'type'), 'figure'), f = ancestor(f, 'figure'); end
  print(f, file, dev, '-r150');
end
